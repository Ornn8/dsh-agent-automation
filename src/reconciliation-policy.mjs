function hasExactReview(comments, base, head) {
  const marker = `<!-- codex-review:${head} -->`
  const exactPair = `_Reviewed exact head \`${head}\` against base \`${base}\``
  return comments.some(comment => comment.body?.includes(marker)
    && /## Codex review: (?:PASS|BLOCK)/.test(comment.body)
    && comment.body.includes(exactPair))
}

/** Return whether a default-branch change requires a fresh exact-pair review. */
export function needsExactReview({ repository, pullRequest, comments, reviewState }) {
  if (pullRequest.draft || pullRequest.head?.repo?.full_name !== repository) return false
  if (pullRequest.mergeable_state === 'behind') return false
  if (reviewState === 'PENDING') return false
  return !hasExactReview(comments, pullRequest.base.sha, pullRequest.head.sha)
}
