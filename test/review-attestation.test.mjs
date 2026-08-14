import assert from 'node:assert/strict'
import test from 'node:test'
import {
  evaluateLanding,
  hasTrustedExactReviewProof,
  hasTrustedExactReviewRun,
  reviewRunIdFromDetailsUrl,
} from '../src/landing-policy.mjs'

const repository = 'owner/repository'
const controllerRepository = 'Ornn8/dsh-agent-automation'
const controllerSha = 'c'.repeat(40)
const base = 'a'.repeat(40)
const head = 'b'.repeat(40)

function pullRequest() {
  return {
    number: 12, repository, state: 'OPEN', isDraft: false, baseRefName: 'main', baseRefOid: base,
    headRefOid: head, mergeStateStatus: 'CLEAN', statusCheckRollup: [],
  }
}

function proof(overrides = {}) {
  return {
    checkRun: {
      name: 'codex/review', status: 'completed', conclusion: 'success',
      app: { id: 15368 }, details_url: 'https://github.com/owner/repository/actions/runs/17/job/1',
    },
    run: {
      id: 17, event: 'pull_request_target', status: 'completed', conclusion: 'success',
      repository: { full_name: repository }, head_repository: { full_name: repository }, head_sha: base,
      pull_requests: [{ number: 12, base: { sha: base }, head: { sha: head } }],
      referenced_workflows: [{ path: `${controllerRepository}/.github/workflows/codex-review.yml@${controllerSha}`,
        sha: controllerSha }],
    },
    ...overrides,
  }
}

test('landing requires an Actions-owned immutable-controller exact-pair review proof', () => {
  const decision = evaluateLanding({
    pullRequest: pullRequest(), expectedHead: head, requiredChecks: ['all checks passed'],
    checkRuns: [{ name: 'all checks passed', status: 'completed', conclusion: 'success' }],
    reviewProof: proof(),
    trustedReview: { controllerRepository, controllerSha, workflowPath: '.github/workflows/codex-review.yml' },
  })
  assert.deepEqual(decision, { ready: true, reason: 'exact review and required checks passed' })
})

test('landing rejects a github-actions comment or status without a bound workflow run', () => {
  const decision = evaluateLanding({
    pullRequest: pullRequest(), expectedHead: head, requiredChecks: ['all checks passed'],
    checkRuns: [{ name: 'all checks passed', status: 'completed', conclusion: 'success' }],
    comments: [{ user: { login: 'github-actions[bot]' }, body: '## Codex review: PASS' }],
    trustedReview: { controllerRepository, controllerSha, workflowPath: '.github/workflows/codex-review.yml' },
  })
  assert.deepEqual(decision, { ready: false, reason: 'no trusted exact-pair Codex PASS exists' })
})

test('a trusted failed review run is terminal evidence but never landing proof', () => {
  const failed = proof({
    checkRun: { ...proof().checkRun, conclusion: 'failure' },
    run: { ...proof().run, conclusion: 'failure' },
  })
  const trustedReview = {
    controllerRepository, controllerSha, workflowPath: '.github/workflows/codex-review.yml',
  }
  assert.equal(hasTrustedExactReviewRun({
    pullRequest: pullRequest(), reviewProof: failed, trustedReview,
  }), true)
  assert.equal(hasTrustedExactReviewProof({
    pullRequest: pullRequest(), reviewProof: failed, trustedReview,
  }), false)
})

test('landing rejects workflow evidence altered by the target pull request', () => {
  const expected = { controllerRepository, controllerSha, workflowPath: '.github/workflows/codex-review.yml' }
  for (const reviewProof of [
    proof({ run: { ...proof().run, referenced_workflows: [{ path: `${controllerRepository}/.github/workflows/codex-review.yml@${'d'.repeat(40)}`, sha: 'd'.repeat(40) }] } }),
    proof({ run: { ...proof().run, referenced_workflows: [{ path: '.github/workflows/codex-review.yml', sha: controllerSha }] } }),
    proof({ run: { ...proof().run, pull_requests: [{ number: 12, base: { sha: 'e'.repeat(40) }, head: { sha: head } }] } }),
    proof({ checkRun: { ...proof().checkRun, app: { id: 1 } } }),
    proof({ checkRun: { ...proof().checkRun, details_url: 'https://example.invalid/actions/runs/17' } }),
  ]) {
    const decision = evaluateLanding({ pullRequest: pullRequest(), expectedHead: head,
      requiredChecks: ['all checks passed'], checkRuns: [{ name: 'all checks passed', status: 'completed', conclusion: 'success' }], reviewProof, trustedReview: expected })
    assert.equal(decision.ready, false)
  }
})

test('review check details URL identifies one GitHub Actions run only', () => {
  assert.equal(reviewRunIdFromDetailsUrl('https://github.com/owner/repository/actions/runs/17/job/1', repository), 17)
  assert.equal(reviewRunIdFromDetailsUrl('https://github.com/other/repository/actions/runs/17', repository), null)
  assert.equal(reviewRunIdFromDetailsUrl('https://github.com/owner/repository/actions/runs/nope', repository), null)
})
