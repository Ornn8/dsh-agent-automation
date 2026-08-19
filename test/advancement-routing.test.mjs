import assert from 'node:assert/strict'
import test from 'node:test'
import { decidePullRequestAdvancement } from '../src/advancement-policy.mjs'
import { buildPullRequestAdvancementSnapshot } from '../src/advancement-state.mjs'
import { loadWorkflowProfile } from '../src/workflow-profile.mjs'
const sha = letter => letter.repeat(40)
const profile = await loadWorkflowProfile()
const trustedReview = { controllerRepository: 'owner/controller', controllerSha: sha('c'), workflowPath: '.github/workflows/agent-review.yml' }
function pullRequest(overrides = {}) {
  return { number: 12, state: 'open', draft: false, mergeable: true,
    base: { ref: 'main', sha: sha('a') }, head: { ref: 'change', sha: sha('b'), repo: { full_name: 'owner/repository' } }, labels: [], ...overrides }
}
function snapshotInput(overrides = {}) {
  return { repository: 'owner/repository', pullRequest: pullRequest(), defaultBranch: 'main',
    expectedPair: { base: sha('a'), head: sha('b') }, profile, requestedWorkflowId: 'default', trustedReview,
    requiredChecks: ['ci'], checkResults: [{ id: 1, name: 'ci', head_sha: sha('b'), status: 'completed', conclusion: 'success', app: { id: 15368 } }],
    governorRecords: [], readRun: async () => { throw new Error('no review run expected') }, readJobs: async () => { throw new Error('no review jobs expected') }, ...overrides }
}
test('CI-first exact state requests review and an old event becomes stale', async () => {
  assert.equal(decidePullRequestAdvancement(await buildPullRequestAdvancementSnapshot(snapshotInput())).action, 'request-review')
  assert.equal(decidePullRequestAdvancement(await buildPullRequestAdvancementSnapshot(snapshotInput({ expectedPair: { base: sha('d'), head: sha('e') } }))).action, 'stale')
})
function reviewCheck({ id, runId, definitionHash }) {
  return { id, name: 'agent/review', head_sha: sha('b'), status: 'completed', conclusion: 'success', app: { id: 15368 },
    details_url: `https://github.com/owner/repository/actions/runs/${runId}`, external_id: `agent-review-v3:default:review:${definitionHash}:${runId}:1` }
}

function reviewRun({ id, controller = 'owner/controller' }) {
  return { id, run_attempt: 1, repository: { full_name: 'owner/repository' }, head_repository: { full_name: 'owner/repository' }, head_sha: sha('b'),
    event: 'pull_request_target', status: 'completed', conclusion: 'success', pull_requests: [{ number: 12, base: { sha: sha('a') }, head: { sha: sha('b') } }],
    referenced_workflows: [{ path: `${controller}/.github/workflows/agent-review.yml@${sha('c')}`, sha: sha('c') }] }
}

test('newer untrusted same-name checks cannot mask an older authoritative exact review', async () => {
  const snapshot = await buildPullRequestAdvancementSnapshot(snapshotInput({
    checkResults: [reviewCheck({ id: 21, runId: 31, definitionHash: profile.definitionHash }), reviewCheck({ id: 20, runId: 30, definitionHash: profile.definitionHash })],
    readRun: async runId => reviewRun({ id: runId, ...(runId === 31 ? { controller: 'attacker/controller' } : {}) }),
    readJobs: async (runId, runAttempt) => [{ id: 500 + runId, run_id: runId, run_attempt: runAttempt }],
  }))
  assert.equal(snapshot.review.state, 'completed')
  assert.equal(snapshot.review.proof.checkRun.id, 20)
})
