import assert from 'node:assert/strict'
import test from 'node:test'
import { needsExactReview } from '../src/reconciliation-policy.mjs'

test('base reconciliation reviews only a mergeable pair without an exact recorded verdict', () => {
  const repository = 'Ornn8/deepseek-harness'
  const base = 'a'.repeat(40)
  const head = 'b'.repeat(40)
  const pullRequest = {
    draft: false,
    mergeable_state: 'clean',
    base: { sha: base },
    head: { sha: head, repo: { full_name: repository } },
  }
  assert.equal(needsExactReview({ repository, pullRequest, comments: [] }), true)
  assert.equal(needsExactReview({
    repository, pullRequest, comments: [], reviewState: 'PENDING',
  }), false)

  const comments = [{
    body: `<!-- codex-review:${head} -->\n## Codex review: BLOCK\n\n_Reviewed exact head \`${head}\` against base \`${base}\` with gpt-5.6-sol (medium)._`,
  }]
  assert.equal(needsExactReview({ repository, pullRequest, comments }), false)

  pullRequest.mergeable_state = 'behind'
  assert.equal(needsExactReview({ repository, pullRequest, comments: [] }), false)
})
