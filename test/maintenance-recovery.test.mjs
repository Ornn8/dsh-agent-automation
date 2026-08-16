import test from 'node:test'
import assert from 'node:assert/strict'
import {
  beginFaultEpoch,
  createFaultRecord,
  nextFaultAction,
  openFaultCircuit,
  recordFaultAttempt,
} from '../src/fault-record.mjs'

const profile = {
  deterministic: {
    actions: ['restart-component', 'start-component', 'reconcile-managed-state'],
    limit: 3,
    backoffSeconds: [0, 0, 0],
  },
  repair: { procedure: 'controller-maintenance-repair', failoverBackoffSeconds: 0 },
  verification: { procedure: 'verify-root-fault' },
}
const workers = ['codex-maintenance', 'opencode-maintenance']
const state = {
  controllerSha: '1'.repeat(40),
  runtimeSnapshotHash: '2'.repeat(64),
  configRevision: 'config-1',
  credentialRevision: 'credential-1',
  healthGeneration: 0,
  failureSignature: `workflow:${'3'.repeat(64)}`,
}

function rootFault() {
  return createFaultRecord({
    repository: 'owner/product',
    component: 'dsh-web-host',
    operation: 'session-list',
    failureClass: 'host',
    errorCode: 'connection-refused',
    rootRequestIds: ['issue-49'],
    stateVersion: state,
    now: '2026-08-16T00:00:00Z',
  })
}

function failDeterministic(record) {
  let next = record
  for (let sequence = 1; sequence <= 3; sequence += 1) {
    const action = nextFaultAction({ record: next, profile, maintenanceWorkers: workers })
    next = recordFaultAttempt(next, {
      kind: 'deterministic', target: action.target, sequence, outcome: 'failed',
      at: `2026-08-16T00:0${sequence}:00Z`,
    })
  }
  return next
}

function verifyThreeTimes(record, startMinute = 6) {
  let next = record
  for (let sequence = 1; sequence <= 3; sequence += 1) {
    next = recordFaultAttempt(next, {
      kind: 'verification', target: 'verify-root-fault', sequence, outcome: 'succeeded', requiredSamples: 3,
      detail: `healthy sample ${sequence}`,
      at: new Date(Date.UTC(2026, 7, 16, 0, startMinute + sequence)).toISOString(),
    })
  }
  return next
}

test('a deterministic DSH Host restart recovers and resumes the original WorkRequest', () => {
  const action = nextFaultAction({ record: rootFault(), profile, maintenanceWorkers: workers })
  assert.equal(action.target, 'restart-component')
  let record = recordFaultAttempt(rootFault(), {
    kind: 'deterministic', target: action.target, sequence: 1, outcome: 'succeeded', at: '2026-08-16T00:01:00Z',
  })
  record = verifyThreeTimes(record, 1)
  assert.deepEqual(nextFaultAction({ record, profile, maintenanceWorkers: workers }), {
    action: 'resume-original', rootRequestIds: ['issue-49'],
  })
})

test('maintenance repair, independent review, CI, release, and verification form one bounded root loop', () => {
  let record = failDeterministic(rootFault())
  const repair = nextFaultAction({ record, profile, maintenanceWorkers: workers })
  record = recordFaultAttempt(record, {
    kind: 'maintenance-worker', target: repair.target, sequence: 1, outcome: 'succeeded', repairPullRequest: 8,
    at: '2026-08-16T00:04:00Z',
  })
  record = recordFaultAttempt(record, { kind: 'review', target: 'reviewer', sequence: 1, outcome: 'succeeded', at: '2026-08-16T00:05:00Z' })
  record = recordFaultAttempt(record, { kind: 'ci', target: 'controller-ci', sequence: 1, outcome: 'succeeded', at: '2026-08-16T00:06:00Z' })
  record = recordFaultAttempt(record, {
    kind: 'promotion', target: 'fault-bound', sequence: 1, outcome: 'succeeded', publishedSha: '4'.repeat(40),
    at: '2026-08-16T00:07:00Z',
  })
  record = verifyThreeTimes(record, 7)
  assert.equal(record.status, 'recovered')
  assert.equal(record.repairPullRequest, 8)
  assert.equal(record.publishedSha, '4'.repeat(40))
})

test('maintenance Worker failover is ordered and never returns to a consumed Worker', () => {
  let record = failDeterministic(rootFault())
  let action = nextFaultAction({ record, profile, maintenanceWorkers: workers })
  assert.equal(action.target, workers[0])
  record = recordFaultAttempt(record, {
    kind: 'maintenance-worker', target: action.target, sequence: 1, outcome: 'failed', at: '2026-08-16T00:04:00Z',
  })
  action = nextFaultAction({ record, profile, maintenanceWorkers: workers })
  assert.equal(action.target, workers[1])
  record = recordFaultAttempt(record, {
    kind: 'maintenance-worker', target: action.target, sequence: 2, outcome: 'succeeded', repairPullRequest: 9,
    at: '2026-08-16T00:05:00Z',
  })
  assert.equal(record.status, 'reviewing')
  assert.deepEqual(record.attempts.filter(attempt => attempt.kind === 'maintenance-worker').map(attempt => attempt.target), workers)
})

test('exhausting both maintenance Workers opens a model-free circuit', () => {
  let record = failDeterministic(rootFault())
  for (let sequence = 1; sequence <= workers.length; sequence += 1) {
    const action = nextFaultAction({ record, profile, maintenanceWorkers: workers })
    record = recordFaultAttempt(record, {
      kind: 'maintenance-worker', target: action.target, sequence, outcome: 'failed',
      at: `2026-08-16T00:0${sequence + 3}:00Z`,
    })
  }
  record = openFaultCircuit(record, 'maintenance-workers-exhausted')
  assert.deepEqual(nextFaultAction({ record, profile, maintenanceWorkers: workers }), { action: 'observe-only' })
})

test('time alone cannot reopen a circuit, while a changed revision or stable-health generation can', () => {
  const record = openFaultCircuit(rootFault(), 'host remains unavailable')
  assert.throws(() => beginFaultEpoch(record, {
    stateVersion: state, now: '2026-08-17T12:00:00Z', maxEpochsPer24Hours: 3,
  }), /changed stateVersion/)
  const revisionEpoch = beginFaultEpoch(record, {
    stateVersion: { ...state, controllerSha: '5'.repeat(40) }, now: '2026-08-17T12:00:00Z', maxEpochsPer24Hours: 3,
  })
  assert.equal(revisionEpoch.epochs.length, 2)
  const healthEpoch = beginFaultEpoch(record, {
    stateVersion: { ...state, healthGeneration: 1 }, now: '2026-08-17T12:00:00Z', maxEpochsPer24Hours: 3,
  })
  assert.equal(healthEpoch.epochs.length, 2)
})
