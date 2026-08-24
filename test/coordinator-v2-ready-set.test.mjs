import assert from 'node:assert/strict'
import test from 'node:test'
import { createTaskClaim } from '../src/coordinator-v2/claim-policy.mjs'
import { selectReadyTaskBatch } from '../src/coordinator-v2/ready-set-policy.mjs'
import { parseTaskDeclaration, taskIdentity } from '../src/coordinator-v2/task-policy.mjs'

const repository = 'Ornn8/example'
const now = '2026-08-23T12:00:00.000Z'
const observedAt = '2026-08-23T12:01:00.000Z'

const body = (dependsOn = [], dispatch = 'ready') => `## Objective\n\nBuild one bounded change.\n\n## Scope\n\nOnly this Issue.\n\n## Acceptance criteria\n\n- Focused tests pass.\n\n<!-- agent-task:v1 -->\n\`\`\`json\n${JSON.stringify({ version: 1, dispatch, dependsOn })}\n\`\`\``

const issue = (number, dependsOn = [], overrides = {}) => ({
  body: body(dependsOn),
  number,
  state: 'open',
  trustedAuthor: true,
  type: 'issue',
  ...overrides,
})

const tracker = number => ({
  body: 'Dependency tracker only.',
  number,
  state: 'open',
  trustedAuthor: true,
  type: 'issue',
})

function taskIdFor(observation) {
  const task = parseTaskDeclaration(observation.body, { issueNumber: observation.number })
  return taskIdentity({ repository, issueNumber: observation.number, task })
}

const claimObservation = (issueNumber, projection) => ({ authenticated: true, issueNumber, projection })

function select(overrides = {}) {
  return selectReadyTaskBatch({
    repository,
    issues: [],
    pullRequests: [],
    claimObservations: [],
    activeLimit: 4,
    batchLimit: 4,
    now: observedAt,
    ...overrides,
  })
}

test('selects independent ready Issues together in stable Issue order', () => {
  const result = select({ issues: [issue(2), issue(1)], activeLimit: 2, batchLimit: 2 })
  assert.equal(result.status, 'ok')
  assert.deepEqual(result.selected.map(task => task.issueNumber), [1, 2])
  assert.equal(result.activeCount, 0)
  assert.equal(result.remainingSlots, 2)
})

test('uses only explicit dependency state and preserves unrelated work', () => {
  const result = select({
    issues: [
      issue(1, [], { state: 'closed' }),
      issue(2, [1]),
      issue(3, [4]),
      tracker(4),
      issue(5),
    ],
    activeLimit: 3,
    batchLimit: 3,
  })
  assert.deepEqual(result.selected.map(task => task.issueNumber), [2, 5])
  assert.deepEqual(
    result.diagnostics.find(item => item.issueNumber === 3),
    { issueNumber: 3, status: 'waiting', reason: 'open-dependencies' },
  )
})

test('counts current claims and one open task pull request as active', () => {
  const first = issue(1)
  const waiting = issue(4, [5])
  const claims = [first, waiting].map((observation, index) => createTaskClaim({
    repository,
    issueNumber: observation.number,
    taskId: taskIdFor(observation),
    claimant: `change/runtime-0${index + 1}`,
    now,
    leaseMs: 5 * 60 * 1_000,
  }))
  const result = select({
    issues: [first, issue(2), issue(3), waiting, tracker(5)],
    pullRequests: [{ issueNumber: 2, number: 101 }],
    claimObservations: claims.map(claim => claimObservation(claim.issueNumber, claim)),
    activeLimit: 4,
    batchLimit: 4,
  })
  assert.equal(result.activeCount, 3)
  assert.equal(result.remainingSlots, 1)
  assert.deepEqual(result.selected.map(task => task.issueNumber), [3])
})

test('a live claim keeps its slot after the Issue becomes invalid, closed, or untrusted', () => {
  const original = issue(5)
  const claim = createTaskClaim({
    repository,
    issueNumber: 5,
    taskId: taskIdFor(original),
    claimant: 'change/runtime-01',
    now,
    leaseMs: 5 * 60 * 1_000,
  })
  const variants = [
    { ...original, body: original.body.replace('"dispatch":"ready",', '') },
    { ...original, state: 'closed' },
    { ...original, trustedAuthor: false },
  ]

  for (const changed of variants) {
    const result = select({
      issues: [changed, issue(6)],
      claimObservations: [claimObservation(5, claim)],
      activeLimit: 1,
      batchLimit: 5,
    })
    assert.equal(result.activeCount, 1)
    assert.deepEqual(result.selected, [])
    assert.deepEqual(
      result.diagnostics.find(item => item.issueNumber === 5),
      { issueNumber: 5, status: 'active', reason: 'current-claim' },
    )
    assert.equal(result.diagnostics.find(item => item.issueNumber === 6).reason, 'repository-limit')
  }
})

test('ignores unauthenticated repository noise before applying the authenticated bound', () => {
  const noise = Array.from({ length: 1_025 }, (_, index) => ({
    authenticated: false,
    issueNumber: 1,
    projection: { noise: index },
  }))
  const result = select({
    issues: [issue(1), issue(2), issue(3)],
    claimObservations: noise,
    activeLimit: 3,
    batchLimit: 3,
  })
  assert.equal(result.status, 'ok')
  assert.deepEqual(result.selected.map(task => task.issueNumber), [1, 2, 3])

  const first = issue(1)
  const claim = createTaskClaim({
    repository,
    issueNumber: 1,
    taskId: taskIdFor(first),
    claimant: 'change/runtime-01',
    now,
    leaseMs: 5 * 60 * 1_000,
  })
  const authenticatedOverflow = Array.from({ length: 1_025 }, () => claimObservation(1, claim))
  const blocked = select({ issues: [first], claimObservations: authenticatedOverflow })
  assert.equal(blocked.status, 'invalid')
  assert.equal(blocked.reason, 'invalid-input')
  assert.equal(blocked.detail, 'Authenticated claim observations are not bounded')
})

test('an authenticated function observation invalidates the repository snapshot', () => {
  const first = issue(1)
  const claim = createTaskClaim({
    repository,
    issueNumber: first.number,
    taskId: taskIdFor(first),
    claimant: 'change/runtime-01',
    now,
    leaseMs: 5 * 60 * 1_000,
  })
  const malformed = function authenticatedClaim() {}
  malformed.authenticated = true
  malformed.issueNumber = first.number
  malformed.projection = claim

  const result = select({ issues: [first], claimObservations: [malformed], activeLimit: 1, batchLimit: 1 })
  assert.equal(result.status, 'invalid')
  assert.equal(result.reason, 'invalid-input')
  assert.equal(result.detail, 'Claim observation must be an object')
  assert.deepEqual(result.selected, [])
})

test('live claims retain slots before Issue and pull-request conflict diagnostics', () => {
  const original = issue(5)
  const claim = createTaskClaim({
    repository,
    issueNumber: 5,
    taskId: taskIdFor(original),
    claimant: 'change/runtime-01',
    now,
    leaseMs: 5 * 60 * 1_000,
  })
  const issueConflict = select({
    issues: [original, { ...original, body: body([], 'hold') }, issue(6)],
    claimObservations: [claimObservation(5, claim)],
    activeLimit: 1,
    batchLimit: 5,
  })
  assert.equal(issueConflict.activeCount, 1)
  assert.deepEqual(issueConflict.selected, [])
  assert.deepEqual(
    issueConflict.diagnostics.find(item => item.issueNumber === 5),
    { issueNumber: 5, status: 'invalid', reason: 'issue-observation-conflict' },
  )
  assert.equal(issueConflict.diagnostics.find(item => item.issueNumber === 6).reason, 'repository-limit')

  const claimedConflict = issue(7)
  const conflictingClaim = createTaskClaim({
    repository,
    issueNumber: 7,
    taskId: taskIdFor(claimedConflict),
    claimant: 'change/runtime-02',
    now,
    leaseMs: 5 * 60 * 1_000,
  })
  const pullRequestConflict = select({
    issues: [issue(5), claimedConflict, issue(8)],
    pullRequests: [{ issueNumber: 5, number: 99 }, { issueNumber: 7, number: 99 }],
    claimObservations: [claimObservation(7, conflictingClaim)],
    activeLimit: 2,
    batchLimit: 5,
  })
  assert.equal(pullRequestConflict.activeCount, 2)
  assert.deepEqual(pullRequestConflict.selected, [])
  assert.deepEqual(
    pullRequestConflict.diagnostics.find(item => item.issueNumber === 7),
    { issueNumber: 7, status: 'invalid', reason: 'pull-request-conflict' },
  )
  assert.equal(pullRequestConflict.diagnostics.find(item => item.issueNumber === 8).reason, 'repository-limit')
})

test('expired and older-task claims do not consume slots', () => {
  const first = issue(1)
  const second = issue(2)
  const expired = createTaskClaim({
    repository,
    issueNumber: 1,
    taskId: taskIdFor(first),
    claimant: 'change/runtime-01',
    now,
    leaseMs: 60_000,
  })
  const stale = createTaskClaim({
    repository,
    issueNumber: 2,
    taskId: `task-${'9'.repeat(64)}`,
    claimant: 'change/runtime-02',
    now,
    leaseMs: 5 * 60 * 1_000,
  })
  const result = select({
    issues: [first, second],
    claimObservations: [claimObservation(1, expired), claimObservation(2, stale)],
    activeLimit: 2,
    batchLimit: 2,
    now: '2026-08-23T12:02:00.000Z',
  })
  assert.equal(result.activeCount, 0)
  assert.deepEqual(result.selected.map(task => task.issueNumber), [1, 2])
})

test('a claim conflict excludes only its Issue', () => {
  const first = issue(1)
  const firstTaskId = taskIdFor(first)
  const claims = ['change/runtime-01', 'change/runtime-02'].map(claimant => createTaskClaim({
    repository,
    issueNumber: 1,
    taskId: firstTaskId,
    claimant,
    now,
    leaseMs: 5 * 60 * 1_000,
  }))
  const result = select({
    issues: [first, issue(2)],
    claimObservations: claims.map(claim => claimObservation(1, claim)),
    activeLimit: 2,
    batchLimit: 2,
  })
  assert.deepEqual(result.selected.map(task => task.issueNumber), [2])
  assert.deepEqual(
    result.diagnostics.find(item => item.issueNumber === 1),
    { issueNumber: 1, status: 'invalid', reason: 'multiple-current-claims' },
  )
})

test('keeps repository limits, batch limits, and requested ordering independent', () => {
  const issues = [issue(1), issue(2), issue(3), issue(4, [5]), tracker(5)]
  const requested = select({ issues, requestedIssueNumber: 3, activeLimit: 3, batchLimit: 1 })
  assert.deepEqual(requested.selected.map(task => task.issueNumber), [3])
  assert.equal(requested.diagnostics.find(item => item.issueNumber === 1).reason, 'batch-limit')

  const paused = select({ issues, activeLimit: 0, batchLimit: 4 })
  assert.deepEqual(paused.selected, [])
  assert.equal(paused.diagnostics.find(item => item.issueNumber === 1).reason, 'repository-limit')

  const ineligibleRequest = select({ issues, requestedIssueNumber: 4, activeLimit: 1, batchLimit: 1 })
  assert.deepEqual(ineligibleRequest.selected.map(task => task.issueNumber), [1])
})

test('is permutation-stable and isolates contradictory or incomplete observations', () => {
  const observations = [issue(1), issue(2), issue(3), issue(1)]
  const forward = select({ issues: observations, activeLimit: 3, batchLimit: 3 })
  const reversed = select({ issues: [...observations].reverse(), activeLimit: 3, batchLimit: 3 })
  assert.deepEqual(forward, reversed)

  const conflictingIssues = select({
    issues: [issue(1), issue(1, [], { body: body([], 'hold') }), issue(2)],
    activeLimit: 2,
    batchLimit: 2,
  })
  assert.deepEqual(conflictingIssues.selected.map(task => task.issueNumber), [2])
  assert.equal(conflictingIssues.diagnostics.find(item => item.issueNumber === 1).reason, 'issue-observation-conflict')

  const conflictingPullRequests = select({
    issues: [issue(1), issue(2), issue(3)],
    pullRequests: [{ issueNumber: 1, number: 900 }, { issueNumber: 2, number: 900 }],
    activeLimit: 3,
    batchLimit: 3,
  })
  assert.deepEqual(conflictingPullRequests.selected.map(task => task.issueNumber), [3])
  assert.equal(conflictingPullRequests.diagnostics.find(item => item.issueNumber === 1).reason, 'pull-request-conflict')
  assert.equal(conflictingPullRequests.diagnostics.find(item => item.issueNumber === 2).reason, 'pull-request-conflict')
  assert.doesNotMatch(JSON.stringify(conflictingPullRequests), /worker|adapter|provider|model|credential|prompt|command/i)

  const incomplete = select({ issues: [issue(1)], pullRequests: [{ issueNumber: 9, number: 901 }] })
  assert.equal(incomplete.reason, 'incomplete-issue-snapshot')
})
