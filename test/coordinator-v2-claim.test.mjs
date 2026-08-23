import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createTaskClaim,
  decideClaimAcquisition,
  parseTaskClaimProjection,
  selectTaskClaim,
} from '../src/coordinator-v2/claim-policy.mjs'

const repository = 'Ornn8/example'
const issueNumber = 9
const taskId = `task-${'1'.repeat(64)}`
const now = '2026-08-23T12:00:00.000Z'
const leaseMs = 5 * 60 * 1_000
const observation = projection => ({ authenticated: true, projection })

test('claim creation is canonical, bounded, and deterministic', () => {
  const first = createTaskClaim({ repository, issueNumber, taskId, claimant: 'change/runtime-01', now, leaseMs })
  const second = createTaskClaim({ repository: 'ornn8/example', issueNumber, taskId, claimant: 'change/runtime-01', now, leaseMs })
  assert.deepEqual(first, second)
  assert.equal(first.repository, 'ornn8/example')
  assert.equal(first.expiresAt, '2026-08-23T12:05:00.000Z')
  assert.deepEqual(parseTaskClaimProjection(first), first)
  assert.throws(() => createTaskClaim({ repository, issueNumber, taskId, claimant: 'bad\nclaimant', now, leaseMs }), /Claimant/)
  assert.throws(() => createTaskClaim({ repository, issueNumber, taskId, claimant: 'change/runtime-01', now, leaseMs: 1 }), /lease/)
})

test('one authenticated current claim is idempotent', () => {
  const claim = createTaskClaim({ repository, issueNumber, taskId, claimant: 'change/runtime-01', now, leaseMs })
  const selected = selectTaskClaim({
    repository,
    issueNumber,
    taskId,
    now: '2026-08-23T12:01:00.000Z',
    observations: [observation(claim), observation(claim), { authenticated: false, projection: { arbitrary: true } }],
  })
  assert.equal(selected.status, 'claimed')
  assert.deepEqual(selected.claim, claim)
})

test('unauthenticated noise does not consume the authenticated observation bound', () => {
  const noise = Array.from({ length: 129 }, (_, index) => ({ authenticated: false, body: `spam ${index}` }))
  assert.deepEqual(
    selectTaskClaim({ repository, issueNumber, taskId, now, observations: noise }),
    { status: 'claimable', reason: 'no-current-claim' },
  )

  const claim = createTaskClaim({ repository, issueNumber, taskId, claimant: 'change/runtime-01', now, leaseMs })
  assert.equal(
    selectTaskClaim({
      repository,
      issueNumber,
      taskId,
      now,
      observations: Array.from({ length: 129 }, () => observation(claim)),
    }).reason,
    'invalid-observations',
  )
})

test('different current claims fail closed independent of input order', () => {
  const first = createTaskClaim({ repository, issueNumber, taskId, claimant: 'change/runtime-01', now, leaseMs })
  const second = createTaskClaim({ repository, issueNumber, taskId, claimant: 'change/runtime-02', now, leaseMs })
  const left = selectTaskClaim({ repository, issueNumber, taskId, now: '2026-08-23T12:01:00.000Z', observations: [observation(first), observation(second)] })
  const right = selectTaskClaim({ repository, issueNumber, taskId, now: '2026-08-23T12:01:00.000Z', observations: [observation(second), observation(first)] })
  assert.equal(left.status, 'conflict')
  assert.deepEqual(left, right)
})

test('expired and stale-task claims do not block replacement', () => {
  const expired = createTaskClaim({ repository, issueNumber, taskId, claimant: 'change/runtime-01', now, leaseMs: 60_000 })
  const stale = createTaskClaim({ repository, issueNumber, taskId: `task-${'2'.repeat(64)}`, claimant: 'change/runtime-02', now, leaseMs })
  const selected = selectTaskClaim({
    repository,
    issueNumber,
    taskId,
    now: '2026-08-23T12:02:00.000Z',
    observations: [observation(expired), observation(stale)],
  })
  assert.deepEqual(selected, { status: 'claimable', reason: 'no-current-claim' })
})

test('authenticated malformed or mismatched claims fail closed', () => {
  const claim = createTaskClaim({ repository, issueNumber, taskId, claimant: 'change/runtime-01', now, leaseMs })
  const wrongRepository = createTaskClaim({
    repository: 'ornn8/other',
    issueNumber,
    taskId,
    claimant: claim.claimant,
    now,
    leaseMs,
  })
  assert.equal(
    selectTaskClaim({ repository, issueNumber, taskId, now, observations: [observation(wrongRepository)] }).reason,
    'claim-subject-mismatch',
  )
  assert.equal(
    selectTaskClaim({ repository, issueNumber, taskId, now, observations: [observation({ ...claim, unknown: true })] }).reason,
    'malformed-authenticated-claim',
  )
  assert.equal(
    selectTaskClaim({ repository, issueNumber, taskId, now: '2026-08-23T11:59:59.000Z', observations: [observation(claim)] }).reason,
    'claim-created-in-future',
  )
})

test('acquisition creates, reuses, waits, or blocks without another state system', () => {
  const eligibility = { status: 'ready', taskId }
  const create = decideClaimAcquisition({
    eligibility,
    selection: { status: 'claimable' },
    repository,
    issueNumber,
    taskId,
    claimant: 'change/runtime-01',
    now,
    leaseMs,
  })
  assert.equal(create.action, 'create')
  assert.equal(
    decideClaimAcquisition({
      eligibility,
      selection: { status: 'claimed', claim: create.claim },
      repository,
      issueNumber,
      taskId,
      claimant: 'change/runtime-01',
      now: '2026-08-23T12:01:00.000Z',
    }).action,
    'existing',
  )
  assert.equal(
    decideClaimAcquisition({
      eligibility,
      selection: { status: 'claimed', claim: create.claim },
      repository,
      issueNumber,
      taskId,
      claimant: 'change/runtime-02',
      now: '2026-08-23T12:01:00.000Z',
    }).action,
    'busy',
  )
  assert.equal(
    decideClaimAcquisition({ eligibility: { status: 'waiting', taskId }, selection: { status: 'claimable' }, taskId }).action,
    'ineligible',
  )
  assert.equal(
    decideClaimAcquisition({
      eligibility,
      selection: { status: 'conflict', reason: 'multiple-current-claims' },
      repository,
      issueNumber,
      taskId,
      claimant: 'change/runtime-01',
      now,
    }).action,
    'blocked',
  )

  const staleClaim = createTaskClaim({
    repository,
    issueNumber,
    taskId: `task-${'2'.repeat(64)}`,
    claimant: 'change/runtime-01',
    now,
    leaseMs,
  })
  assert.equal(
    decideClaimAcquisition({
      eligibility,
      selection: { status: 'claimed', claim: staleClaim },
      repository,
      issueNumber,
      taskId,
      claimant: 'change/runtime-01',
      now: '2026-08-23T12:01:00.000Z',
    }).reason,
    'claim-subject-mismatch',
  )

  const expiredClaim = createTaskClaim({
    repository,
    issueNumber,
    taskId,
    claimant: 'change/runtime-01',
    now,
    leaseMs: 60_000,
  })
  assert.equal(
    decideClaimAcquisition({
      eligibility,
      selection: { status: 'claimed', claim: expiredClaim },
      repository,
      issueNumber,
      taskId,
      claimant: 'change/runtime-01',
      now: '2026-08-23T12:02:00.000Z',
    }).reason,
    'claim-selection-stale',
  )
})
