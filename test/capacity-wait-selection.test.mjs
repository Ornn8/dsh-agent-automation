import test from 'node:test'
import assert from 'node:assert/strict'
import { selectCapacityWaitingWork as select } from '../src/dispatch-policy.mjs'
const stateVersion = 'b'.repeat(64)
const projection = {
  version: 1,
  workRequestId: 'repair-request-1',
  role: 'change',
  repository: 'Ornn8/deepseek-harness',
  profileId: 'github-pr-cycle',
  workflowId: 'repair',
  stageId: 'change',
  definitionHash: 'a'.repeat(64),
  revision: { base: 'c'.repeat(40), head: 'd'.repeat(40) },
  coordinationKey: 'Ornn8/deepseek-harness:github-pr-cycle:repair',
  subject: {
    type: 'pull-request', number: 10, stateVersion,
    base: 'c'.repeat(40), head: 'd'.repeat(40),
  },
  routeDecision: {
    version: 1, workRequestId: 'repair-request-1', role: 'change', stateVersion,
    taskClass: 'default', policyHash: 'e'.repeat(64), evidenceHash: 'f'.repeat(64),
  },
  capacityGenerationHash: '1'.repeat(64),
  observationId: 'run-1:1',
}
const pullRequest = {
  number: 10,
  state: 'open',
  draft: false,
  head: { sha: 'd'.repeat(40), repo: { full_name: 'Ornn8/deepseek-harness' } },
  base: { sha: 'c'.repeat(40) },
  labels: [],
}
function waiting(overrides = {}) {
  return {
    repository: 'Ornn8/deepseek-harness',
    projection,
    currentStateVersion: stateVersion,
    ...overrides,
  }
}
function selectCapacityWaitingWork(options = {}) {
  return select({ repository: projection.repository, ...options })
}
test('selection returns one exact open pull request in stable number order', () => {
  const selected = selectCapacityWaitingWork({
    pullRequests: [pullRequest, { ...pullRequest, number: 11 }],
    capacityWaits: [waiting({ projection: { ...projection, subject: { ...projection.subject, number: 11 } } }), waiting()],
  })
  assert.equal(selected.type, 'repair')
  assert.equal(selected.number, 10)
  assert.equal(selected.head, 'd'.repeat(40))
  assert.equal(selected.projection, projection)
})
test('selection rejects stale, changed, draft, and terminal subjects', () => {
  assert.equal(selectCapacityWaitingWork({
    pullRequests: [pullRequest], capacityWaits: [waiting({ currentStateVersion: '0'.repeat(64) })],
  }), null)
  assert.equal(selectCapacityWaitingWork({
    pullRequests: [{ ...pullRequest, head: { ...pullRequest.head, sha: '0'.repeat(40) } }], capacityWaits: [waiting()],
  }), null)
  for (const change of [
    { draft: true },
    { labels: [{ name: 'automation/repair-blocked' }] },
    { labels: [{ name: 'automation/paused' }] },
  ]) {
    assert.equal(selectCapacityWaitingWork({
      pullRequests: [{ ...pullRequest, ...change }], capacityWaits: [waiting()],
    }), null)
  }
})
test('selection rejects a same-number subject from a different repository', () => {
  assert.equal(selectCapacityWaitingWork({
    pullRequests: [{
      ...pullRequest,
      head: { ...pullRequest.head, repo: { full_name: 'Other/repository' } },
    }],
    capacityWaits: [waiting()],
  }), null)
  assert.equal(selectCapacityWaitingWork({
    pullRequests: [pullRequest],
    capacityWaits: [waiting({ repository: 'Other/repository' })],
  }), null)
})
test('selection requires trusted repository context for Issue waits', () => {
  const issue = { number: 7, state: 'open', labels: [] }
  const issueProjection = { ...projection, subject: { type: 'issue', number: 7, stateVersion } }
  const options = { issues: [issue], capacityWaits: [waiting({ projection: issueProjection })] }
  assert.equal(select({ repository: 'Other/repository', ...options }), null)
  assert.equal(select(options), null)
  assert.deepEqual(selectCapacityWaitingWork(options), { type: 'issue', number: 7, projection: issueProjection })
})

test('selection keeps Issue waits distinct from linked pull requests and blocked issues', () => {
  const issue = { number: 7, state: 'open', labels: [] }
  const issueProjection = {
    ...projection,
    workRequestId: 'issue-request-7',
    workflowId: 'issue-work',
    revision: { base: 'f'.repeat(40), head: 'f'.repeat(40) },
    subject: { type: 'issue', number: 7, stateVersion },
    routeDecision: { ...projection.routeDecision, workRequestId: 'issue-request-7' },
  }
  const selected = selectCapacityWaitingWork({
    issues: [issue], pullRequests: [],
    capacityWaits: [waiting({ projection: issueProjection })],
  })
  assert.deepEqual(selected, { type: 'issue', number: 7, projection: issueProjection })
  assert.equal(selectCapacityWaitingWork({
    issues: [issue], pullRequests: [{ body: 'Fixes #7' }],
    capacityWaits: [waiting({ projection: issueProjection })],
  }), null)
  assert.equal(selectCapacityWaitingWork({
    issues: [{ ...issue, labels: [{ name: 'agent/dsh-blocked' }] }],
    capacityWaits: [waiting({ projection: issueProjection })],
  }), null)
})
