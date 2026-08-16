import test from 'node:test'
import assert from 'node:assert/strict'
import {
  attachRootRequests,
  beginFaultEpoch,
  createFaultRecord,
  faultIdentity,
  faultStateVersion,
  nextFaultAction,
  openFaultCircuit,
  parseFaultRecord,
  recordFaultAttempt,
} from '../src/fault-record.mjs'

const now = '2026-08-16T00:00:00.000Z'
const state = {
  controllerSha: '1'.repeat(40),
  runtimeSnapshotHash: '2'.repeat(64),
  configRevision: 'config-1',
  credentialRevision: 'credential-1',
  healthGeneration: 0,
  failureSignature: 'ECONNREFUSED:3080',
}
const profile = {
  deterministic: {
    actions: ['restart-role', 'reconcile-runtime', 'refresh-registration'],
    limit: 3,
    backoffSeconds: [30, 120, 300],
  },
  repair: { procedure: 'controller-maintenance-repair', failoverBackoffSeconds: 300 },
  verification: { procedure: 'verify-root-fault' },
}

function fault() {
  return createFaultRecord({
    repository: 'Ornn8/dsh-agent-automation', component: 'dsh-web-host', operation: 'session-list',
    failureClass: 'host', errorCode: 'ECONNREFUSED 127.0.0.1:3080', rootRequestIds: ['request-b', 'request-a'],
    stateVersion: state, now,
  })
}

test('fault identity is stable across volatile numbers and request order', () => {
  const common = { repository: 'Ornn8/dsh-agent-automation', component: 'runner', operation: 'start', failureClass: 'host' }
  assert.equal(
    faultIdentity({ ...common, errorCode: 'process 12345 failed with 0xC000013A' }),
    faultIdentity({ ...common, errorCode: 'process 99887 failed with 0xDEADBEEF' }),
  )
  assert.deepEqual(fault().rootRequestIds, ['request-a', 'request-b'])
})

test('state versions exclude wall-clock time and require meaningful revision fields', () => {
  assert.deepEqual(faultStateVersion(state), faultStateVersion({ ...state }))
  assert.throws(() => faultStateVersion({ ...state, observedAt: now }), /unknown field observedAt/)
})

test('deterministic recovery is bounded before ordered maintenance failover', () => {
  let record = fault()
  for (let sequence = 1; sequence <= 3; sequence += 1) {
    const action = nextFaultAction({ record, profile, maintenanceWorkers: ['codex-maintenance', 'opencode-maintenance'] })
    assert.equal(action.action, 'deterministic')
    assert.equal(action.sequence, sequence)
    record = recordFaultAttempt(record, {
      kind: 'deterministic', target: action.target, sequence, outcome: 'failed', at: new Date(Date.parse(now) + sequence * 1_000).toISOString(),
    })
  }
  let action = nextFaultAction({ record, profile, maintenanceWorkers: ['codex-maintenance', 'opencode-maintenance'] })
  assert.deepEqual(action, {
    action: 'maintenance-worker', target: 'codex-maintenance', procedure: 'controller-maintenance-repair', sequence: 1,
  })
  record = recordFaultAttempt(record, {
    kind: 'maintenance-worker', target: action.target, sequence: 1, outcome: 'failed', at: '2026-08-16T00:01:00Z',
  })
  assert.deepEqual(nextFaultAction({
    record, profile, maintenanceWorkers: ['codex-maintenance', 'opencode-maintenance'], now: '2026-08-16T00:01:01Z',
  }), { action: 'wait', readyAt: '2026-08-16T00:06:00.000Z' })
  action = nextFaultAction({ record, profile, maintenanceWorkers: ['codex-maintenance', 'opencode-maintenance'] })
  assert.equal(action.target, 'opencode-maintenance')
  record = recordFaultAttempt(record, {
    kind: 'maintenance-worker', target: action.target, sequence: 2, outcome: 'failed', at: '2026-08-16T00:02:00Z',
  })
  assert.equal(nextFaultAction({ record, profile, maintenanceWorkers: ['codex-maintenance', 'opencode-maintenance'] }).action, 'open-circuit')
})

test('one epoch permits one repair PR and resumes original requests only after verification', () => {
  let record = fault()
  record = recordFaultAttempt(record, {
    kind: 'maintenance-worker', target: 'codex-maintenance', sequence: 1, outcome: 'succeeded',
    repairPullRequest: 42, at: '2026-08-16T00:01:00Z',
  })
  assert.equal(record.status, 'reviewing')
  assert.equal(record.repairPullRequest, 42)
  record = recordFaultAttempt(record, { kind: 'review', target: 'agent-review', sequence: 1, outcome: 'succeeded', at: '2026-08-16T00:02:00Z' })
  record = recordFaultAttempt(record, { kind: 'ci', target: 'controller-ci', sequence: 1, outcome: 'succeeded', at: '2026-08-16T00:03:00Z' })
  record = recordFaultAttempt(record, { kind: 'promotion', target: 'fault-bound', sequence: 1, outcome: 'succeeded', publishedSha: '3'.repeat(40), at: '2026-08-16T00:04:00Z' })
  record = recordFaultAttempt(record, { kind: 'verification', target: 'verify-root-fault', sequence: 1, outcome: 'succeeded', detail: 'three readiness checks passed', at: '2026-08-16T00:05:00Z' })
  assert.equal(record.status, 'recovered')
  assert.deepEqual(nextFaultAction({ record, profile, maintenanceWorkers: [] }), { action: 'resume-original', rootRequestIds: ['request-a', 'request-b'] })
})

test('stable health verification requires the configured number of durable samples', () => {
  let record = recordFaultAttempt(fault(), {
    kind: 'deterministic', target: 'restart-component', sequence: 1, outcome: 'succeeded', at: '2026-08-16T00:01:00Z',
  })
  for (let sequence = 1; sequence <= 2; sequence += 1) {
    record = recordFaultAttempt(record, {
      kind: 'verification', target: 'verify-root-fault', sequence, outcome: 'succeeded', requiredSamples: 3,
      detail: `healthy sample ${sequence}`, at: `2026-08-16T00:0${sequence + 1}:00Z`,
    })
    assert.equal(record.status, 'verifying')
  }
  record = recordFaultAttempt(record, {
    kind: 'verification', target: 'verify-root-fault', sequence: 3, outcome: 'succeeded', requiredSamples: 3,
    detail: 'healthy sample 3', at: '2026-08-16T00:04:00Z',
  })
  assert.equal(record.status, 'recovered')
})

test('circuit epochs require changed state and obey a rolling 24 hour budget', () => {
  let record = openFaultCircuit(fault(), 'all maintenance workers failed')
  assert.throws(() => beginFaultEpoch(record, { stateVersion: state, now: '2026-08-16T01:00:00Z', maxEpochsPer24Hours: 3 }), /changed stateVersion/)
  record = beginFaultEpoch(record, { stateVersion: { ...state, configRevision: 'config-2' }, now: '2026-08-16T01:00:00Z', maxEpochsPer24Hours: 3 })
  record = openFaultCircuit(record, 'failed again')
  record = beginFaultEpoch(record, { stateVersion: { ...state, configRevision: 'config-3' }, now: '2026-08-16T02:00:00Z', maxEpochsPer24Hours: 3 })
  record = openFaultCircuit(record, 'failed again')
  assert.throws(() => beginFaultEpoch(record, { stateVersion: { ...state, configRevision: 'config-4' }, now: '2026-08-16T03:00:00Z', maxEpochsPer24Hours: 3 }), /rolling epoch budget/)
  const later = beginFaultEpoch(record, { stateVersion: { ...state, configRevision: 'config-4' }, now: '2026-08-17T03:00:01Z', maxEpochsPer24Hours: 3 })
  assert.equal(later.epochs.length, 4)
})

test('a child failure attaches to the root and never changes fault identity', () => {
  const record = attachRootRequests(fault(), ['request-c', 'request-a'])
  assert.deepEqual(record.rootRequestIds, ['request-a', 'request-b', 'request-c'])
  assert.equal(parseFaultRecord(record).faultId, fault().faultId)
})
