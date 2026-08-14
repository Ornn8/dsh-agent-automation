import assert from 'node:assert/strict'
import test from 'node:test'
import { evaluateLanding } from '../src/landing-policy.mjs'

const pullRequest = (baseRefOid, headRefOid) => ({
  number: 12, repository: 'owner/repository', state: 'OPEN',
  isDraft: false,
  baseRefName: 'master',
  baseRefOid,
  headRefOid,
  mergeStateStatus: 'CLEAN',
})
const proof = (base, head) => ({ checkRun: {
  name: 'codex/review', status: 'completed', conclusion: 'success', app: { id: 15368 },
  details_url: 'https://github.com/owner/repository/actions/runs/17',
}, run: { id: 17, event: 'pull_request_target', status: 'completed', conclusion: 'success', head_sha: head,
  repository: { full_name: 'owner/repository' }, head_repository: { full_name: 'owner/repository' },
  pull_requests: [{ number: 12, base: { sha: base }, head: { sha: head } }],
  referenced_workflows: [{ path: `Ornn8/dsh-agent-automation/.github/workflows/codex-review.yml@${'c'.repeat(40)}`, sha: 'c'.repeat(40) }],
} })
const trustedReview = { controllerRepository: 'Ornn8/dsh-agent-automation', controllerSha: 'c'.repeat(40), workflowPath: '.github/workflows/codex-review.yml' }
const checks = [{ name: 'all checks passed', status: 'completed', conclusion: 'success' }]

test('landing accepts only a current exact-pair PASS with every required check green', () => {
  const base = 'a'.repeat(40)
  const head = 'b'.repeat(40)
  const decision = evaluateLanding({
    pullRequest: pullRequest(base, head),
    expectedHead: head,
    requiredChecks: ['all checks passed'], checkRuns: checks, reviewProof: proof(base, head), trustedReview,
  })
  assert.deepEqual(decision, { ready: true, reason: 'exact review and required checks passed' })
})

test('landing rejects a pull_request_target run whose head_sha is the base commit', () => {
  const base = 'a'.repeat(40)
  const head = 'b'.repeat(40)
  const reviewProof = proof(base, head)
  reviewProof.run.head_sha = base
  assert.equal(evaluateLanding({
    pullRequest: pullRequest(base, head), expectedHead: head,
    requiredChecks: ['all checks passed'], checkRuns: checks, reviewProof, trustedReview,
  }).ready, false)
})

test('landing rejects a head-only PASS after the base changes', () => {
  const reviewedBase = 'a'.repeat(40)
  const currentBase = 'c'.repeat(40)
  const head = 'b'.repeat(40)
  const decision = evaluateLanding({
    pullRequest: pullRequest(currentBase, head),
    expectedHead: head,
    requiredChecks: ['all checks passed'], checkRuns: checks, reviewProof: proof(reviewedBase, head), trustedReview,
  })
  assert.deepEqual(decision, { ready: false, reason: 'no trusted exact-pair Codex PASS exists' })
})

test('landing rejects a missing trusted workflow proof even when checks are green', () => {
  const base = 'a'.repeat(40)
  const head = 'b'.repeat(40)
  const decision = evaluateLanding({
    pullRequest: pullRequest(base, head),
    expectedHead: head,
    requiredChecks: ['all checks passed'], checkRuns: checks, reviewProof: null, trustedReview,
  })
  assert.deepEqual(decision, { ready: false, reason: 'no trusted exact-pair Codex PASS exists' })
})

test('landing uses the newest app-bound required check rather than an older success', () => {
  const currentPullRequest = pullRequest('a'.repeat(40), 'b'.repeat(40))
  const reviewProof = proof(currentPullRequest.baseRefOid, currentPullRequest.headRefOid)
  const decision = evaluateLanding({
    pullRequest: currentPullRequest,
    expectedHead: currentPullRequest.headRefOid,
    requiredChecks: [{ context: 'all checks passed', app_id: 15368 }],
    checkRuns: [
      { id: 10, name: 'all checks passed', status: 'completed', conclusion: 'success', app: { id: 15368 } },
      { id: 11, name: 'all checks passed', status: 'completed', conclusion: 'failure', app: { id: 15368 } },
      { id: 12, name: 'all checks passed', status: 'completed', conclusion: 'success', app: { id: 1 } },
    ],
    reviewProof,
    trustedReview,
  })
  assert.deepEqual(decision, { ready: false, reason: 'required check all checks passed has not passed' })
})
