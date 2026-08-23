const SHA_PATTERN = /^[0-9a-f]{40}$/

function validPair(baseSha, headSha) {
  return SHA_PATTERN.test(baseSha || '') && SHA_PATTERN.test(headSha || '') && baseSha !== headSha
}

function repairAvailable(repair) {
  const attempts = Number.isSafeInteger(repair?.attempts) && repair.attempts >= 0 ? repair.attempts : 0
  const limit = Number.isSafeInteger(repair?.limit) && repair.limit >= 0 ? repair.limit : 0
  return attempts < limit
}

function currentReview(review, baseSha, headSha) {
  if (!review || review.baseSha !== baseSha || review.headSha !== headSha) return 'missing'
  return ['pending', 'passed', 'blocked'].includes(review.status) ? review.status : 'missing'
}

function currentCi(ci, headSha) {
  if (!ci || ci.headSha !== headSha) return 'pending'
  return ['pending', 'passed', 'failed'].includes(ci.status) ? ci.status : 'pending'
}

export function decidePullRequestAction({ pullRequest, ci, review, repair = {} } = {}) {
  if (!pullRequest || pullRequest.state !== 'open') return { action: 'terminal', reason: 'pull-request-not-open' }
  if (pullRequest.draft) return { action: 'paused', reason: 'draft' }

  const { baseSha, headSha } = pullRequest
  if (!validPair(baseSha, headSha)) return { action: 'blocked', reason: 'invalid-pair' }
  if (repair.active) return { action: 'wait-repair', reason: 'repair-active', baseSha, headSha }

  const reviewStatus = currentReview(review, baseSha, headSha)
  if (reviewStatus === 'missing') return { action: 'request-review', reason: 'review-missing', baseSha, headSha }
  if (reviewStatus === 'pending') return { action: 'wait-review', reason: 'review-pending', baseSha, headSha }
  if (reviewStatus === 'blocked') {
    return repairAvailable(repair)
      ? { action: 'request-repair', reason: 'review-blocked', baseSha, headSha }
      : { action: 'blocked', reason: 'repair-limit', baseSha, headSha }
  }

  const ciStatus = currentCi(ci, headSha)
  if (ciStatus === 'pending') return { action: 'wait-checks', reason: 'checks-pending', baseSha, headSha }
  if (ciStatus === 'failed') {
    return repairAvailable(repair)
      ? { action: 'request-repair', reason: 'checks-failed', baseSha, headSha }
      : { action: 'blocked', reason: 'repair-limit', baseSha, headSha }
  }

  if (pullRequest.mergeable === true) return { action: 'request-merge', reason: 'ready', baseSha, headSha }
  if (pullRequest.mergeable === null || pullRequest.mergeable === undefined) {
    return { action: 'wait-mergeable', reason: 'mergeability-unknown', baseSha, headSha }
  }
  return repairAvailable(repair)
    ? { action: 'request-repair', reason: 'merge-conflict', baseSha, headSha }
    : { action: 'blocked', reason: 'repair-limit', baseSha, headSha }
}
