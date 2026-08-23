const SHA_PATTERN = /^[0-9a-f]{40}$/
const REPAIR_FIELDS = ['active', 'attempts', 'limit']

function validPair(baseSha, headSha) {
  return SHA_PATTERN.test(baseSha || '') && SHA_PATTERN.test(headSha || '') && baseSha !== headSha
}

function normalizeRepairState(repair) {
  if (repair === undefined) return { active: false, attempts: 0, limit: 0 }
  if (!repair || typeof repair !== 'object' || Array.isArray(repair)) {
    throw new Error('Repair state must be an object')
  }
  const unknown = Object.keys(repair).filter(field => !REPAIR_FIELDS.includes(field))
  if (unknown.length > 0) throw new Error('Repair state has unknown fields')

  const active = repair.active === undefined ? false : repair.active
  const attempts = repair.attempts === undefined ? 0 : repair.attempts
  const limit = repair.limit === undefined ? 0 : repair.limit
  if (typeof active !== 'boolean') throw new Error('Repair active must be boolean')
  if (!Number.isSafeInteger(attempts) || attempts < 0) {
    throw new Error('Repair attempts must be a non-negative safe integer')
  }
  if (!Number.isSafeInteger(limit) || limit < 0) {
    throw new Error('Repair limit must be a non-negative safe integer')
  }
  return { active, attempts, limit }
}

function repairAvailable(repair) {
  return repair.attempts < repair.limit
}

function currentReview(review, baseSha, headSha) {
  if (!review || review.baseSha !== baseSha || review.headSha !== headSha) return 'missing'
  return ['pending', 'passed', 'blocked'].includes(review.status) ? review.status : 'missing'
}

function currentCi(ci, headSha) {
  if (!ci || ci.headSha !== headSha) return 'pending'
  return ['pending', 'passed', 'failed'].includes(ci.status) ? ci.status : 'pending'
}

export function decidePullRequestAction({ pullRequest, ci, review, repair } = {}) {
  if (!pullRequest || pullRequest.state !== 'open') return { action: 'terminal', reason: 'pull-request-not-open' }
  if (pullRequest.draft) return { action: 'paused', reason: 'draft' }

  const { baseSha, headSha } = pullRequest
  if (!validPair(baseSha, headSha)) return { action: 'blocked', reason: 'invalid-pair' }

  let normalizedRepair
  try {
    normalizedRepair = normalizeRepairState(repair)
  } catch (error) {
    return { action: 'blocked', reason: 'invalid-repair-state', detail: error.message, baseSha, headSha }
  }
  if (normalizedRepair.active) return { action: 'wait-repair', reason: 'repair-active', baseSha, headSha }

  const reviewStatus = currentReview(review, baseSha, headSha)
  if (reviewStatus === 'missing') return { action: 'request-review', reason: 'review-missing', baseSha, headSha }
  if (reviewStatus === 'pending') return { action: 'wait-review', reason: 'review-pending', baseSha, headSha }
  if (reviewStatus === 'blocked') {
    return repairAvailable(normalizedRepair)
      ? { action: 'request-repair', reason: 'review-blocked', baseSha, headSha }
      : { action: 'blocked', reason: 'repair-limit', baseSha, headSha }
  }

  const ciStatus = currentCi(ci, headSha)
  if (ciStatus === 'pending') return { action: 'wait-checks', reason: 'checks-pending', baseSha, headSha }
  if (ciStatus === 'failed') {
    return repairAvailable(normalizedRepair)
      ? { action: 'request-repair', reason: 'checks-failed', baseSha, headSha }
      : { action: 'blocked', reason: 'repair-limit', baseSha, headSha }
  }

  if (pullRequest.mergeable === true) return { action: 'request-merge', reason: 'ready', baseSha, headSha }
  if (pullRequest.mergeable === null || pullRequest.mergeable === undefined) {
    return { action: 'wait-mergeable', reason: 'mergeability-unknown', baseSha, headSha }
  }
  if (pullRequest.mergeable !== false) {
    return { action: 'blocked', reason: 'invalid-mergeability', baseSha, headSha }
  }
  return repairAvailable(normalizedRepair)
    ? { action: 'request-repair', reason: 'merge-conflict', baseSha, headSha }
    : { action: 'blocked', reason: 'repair-limit', baseSha, headSha }
}
