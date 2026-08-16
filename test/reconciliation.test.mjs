import assert from 'node:assert/strict'
import test from 'node:test'
import { needsDefaultBranchUpdate, needsExactReview } from '../src/reconciliation-policy.mjs'

test('base reconciliation compares immutable commits instead of transient mergeability', () => {
  const currentBase = 'b'.repeat(40)
  const oldMergeBase = 'a'.repeat(40)
  const pullRequest = {
    mergeable_state: 'unknown',
    base: { ref: 'master', sha: currentBase },
  }
  assert.equal(needsDefaultBranchUpdate({
    defaultBranch: 'master', defaultBranchHead: currentBase, mergeBaseSha: oldMergeBase, pullRequest,
  }), true)

  pullRequest.mergeable_state = 'behind'
  assert.equal(needsDefaultBranchUpdate({
    defaultBranch: 'master', defaultBranchHead: currentBase, mergeBaseSha: currentBase, pullRequest,
  }), false)
})

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
