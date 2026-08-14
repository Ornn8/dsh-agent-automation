function checkName(check) {
  return check.__typename === 'StatusContext' ? check.context : check.name
}

function checkPassed(check) {
  if (check.__typename === 'StatusContext') return check.state === 'SUCCESS'
  return check.status === 'COMPLETED'
    && ['SUCCESS', 'SKIPPED', 'NEUTRAL'].includes(check.conclusion)
}

// The Codex review comment is published by the job-scoped Actions token, which
// GitHub attributes to github-actions[bot]. Only that bot identity may satisfy
// the landing gate: matching the body text alone would let a pull request
// author post a forged PASS comment for the exact base and head pair and then
// merge through the successful-CI landing path without an authentic verdict.
const TRUSTED_REVIEWER_LOGIN = 'github-actions[bot]'

function isTrustedReviewer(comment) {
  return comment.user?.type === 'Bot' && comment.user?.login === TRUSTED_REVIEWER_LOGIN
}

function hasExactPassingReview(comments, base, head) {
  const marker = `<!-- codex-review:${head} -->`
  const exactPair = `_Reviewed exact head \`${head}\` against base \`${base}\``
  return comments.some(comment => isTrustedReviewer(comment)
    && comment.body?.includes(marker)
    && comment.body.includes('## Codex review: PASS')
    && comment.body.includes(exactPair))
}

/** Decide whether a pull request is ready for the privileged landing operation. */
export function evaluateLanding({ pullRequest, expectedHead, requiredChecks, comments }) {
  if (pullRequest.state !== 'OPEN' || pullRequest.isDraft) {
    return { ready: false, reason: 'pull request is not open and ready' }
  }
  if (pullRequest.baseRefName !== 'master') {
    return { ready: false, reason: 'only master pull requests are auto-landed' }
  }
  if (pullRequest.headRefOid !== expectedHead) {
    return { ready: false, reason: 'pull request head changed' }
  }
  if (pullRequest.mergeStateStatus !== 'CLEAN') {
    return { ready: false, reason: `merge state is ${pullRequest.mergeStateStatus}` }
  }
  if (!hasExactPassingReview(comments, pullRequest.baseRefOid, pullRequest.headRefOid)) {
    return { ready: false, reason: 'no exact base and head Codex PASS exists' }
  }
  const checks = pullRequest.statusCheckRollup || []
  for (const required of requiredChecks) {
    if (!checks.some(check => checkName(check) === required && checkPassed(check))) {
      return { ready: false, reason: `required check ${required} has not passed` }
    }
  }
  return { ready: true, reason: 'exact review and required checks passed' }
}
