import assert from 'node:assert/strict'
import test from 'node:test'
import { needsExactReview } from '../src/reconciliation-policy.mjs'

test('base reconciliation reviews only a default-branch pair without trusted exact-pair evidence', () => {
  const repository = 'Ornn8/deepseek-harness'
  const base = 'a'.repeat(40)
  const head = 'b'.repeat(40)
  const pullRequest = {
    draft: false,
    mergeable_state: 'clean',
    base: { ref: 'master', sha: base },
    head: { sha: head, repo: { full_name: repository } },
  }
  assert.equal(needsExactReview({ repository, defaultBranch: 'master', pullRequest, reviewProof: null }), true)
  assert.equal(needsExactReview({
    repository, defaultBranch: 'master', pullRequest, reviewProof: null, reviewState: 'PENDING',
  }), true)

  assert.equal(needsExactReview({ repository, defaultBranch: 'master', pullRequest, reviewProof: { base, head, state: 'block' } }), false)

  pullRequest.base.ref = 'stacked-base'
  assert.equal(needsExactReview({ repository, defaultBranch: 'master', pullRequest, comments: [] }), false)
})
