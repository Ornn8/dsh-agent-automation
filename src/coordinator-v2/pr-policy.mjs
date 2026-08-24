// @ts-check

const SHA_PATTERN = /^[0-9a-f]{40}$/
const REPAIR_FIELDS = ['active', 'attempts', 'limit']

/** @typedef {{ active: boolean, attempts: number, limit: number }} RepairState */
/** @typedef {'missing' | 'pending' | 'passed' | 'blocked'} ReviewStatus */
/** @typedef {'pending' | 'passed' | 'failed'} CiStatus */

/**
 * @typedef {{
 *   pullRequest?: unknown,
 *   ci?: unknown,
 *   review?: unknown,
 *   repair?: unknown,
 * }} PullRequestDecisionInput
 */

/**
 * @param {unknown} value
 * @returns {Record<string, unknown> | null}
 */
function objectRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? /** @type {Record<string, unknown>} */ (value)
    : null
}

/**
 * @param {unknown} baseSha
 * @param {unknown} headSha
 * @returns {boolean}
 */
function validPair(baseSha, headSha) {
  return typeof baseSha === 'string'
    && typeof headSha === 'string'
    && SHA_PATTERN.test(baseSha)
    && SHA_PATTERN.test(headSha)
    && baseSha !== headSha
}

/**
 * @param {unknown} repair
 * @returns {RepairState}
 */
function normalizeRepairState(repair) {
  if (repair === undefined) return { active: false, attempts: 0, limit: 0 }
  const record = objectRecord(repair)
  if (!record) throw new Error('Repair state must be an object')
  const unknown = Object.keys(record).filter(field => !REPAIR_FIELDS.includes(field))
  if (unknown.length > 0) throw new Error('Repair state has unknown fields')

  const active = record.active === undefined ? false : record.active
  const attempts = record.attempts === undefined ? 0 : record.attempts
  const limit = record.limit === undefined ? 0 : record.limit
  if (typeof active !== 'boolean') throw new Error('Repair active must be boolean')
  if (!Number.isSafeInteger(attempts) || /** @type {number} */ (attempts) < 0) {
    throw new Error('Repair attempts must be a non-negative safe integer')
  }
  if (!Number.isSafeInteger(limit) || /** @type {number} */ (limit) < 0) {
    throw new Error('Repair limit must be a non-negative safe integer')
  }
  return {
    active,
    attempts: /** @type {number} */ (attempts),
    limit: /** @type {number} */ (limit),
  }
}

/**
 * @param {RepairState} repair
 * @returns {boolean}
 */
function repairAvailable(repair) {
  return repair.attempts < repair.limit
}

/**
 * @param {unknown} review
 * @param {string} baseSha
 * @param {string} headSha
 * @returns {ReviewStatus}
 */
function currentReview(review, baseSha, headSha) {
  const record = objectRecord(review)
  if (!record || record.baseSha !== baseSha || record.headSha !== headSha) return 'missing'
  return record.status === 'pending' || record.status === 'passed' || record.status === 'blocked'
    ? record.status
    : 'missing'
}

/**
 * @param {unknown} ci
 * @param {string} headSha
 * @returns {CiStatus}
 */
function currentCi(ci, headSha) {
  const record = objectRecord(ci)
  if (!record || record.headSha !== headSha) return 'pending'
  return record.status === 'pending' || record.status === 'passed' || record.status === 'failed'
    ? record.status
    : 'pending'
}

/**
 * @param {PullRequestDecisionInput} [input]
 */
export function decidePullRequestAction({ pullRequest, ci, review, repair } = {}) {
  const pullRequestRecord = objectRecord(pullRequest)
  if (!pullRequestRecord || pullRequestRecord.state !== 'open') {
    return { action: 'terminal', reason: 'pull-request-not-open' }
  }
  if (pullRequestRecord.draft) return { action: 'paused', reason: 'draft' }

  const baseSha = pullRequestRecord.baseSha
  const headSha = pullRequestRecord.headSha
  if (!validPair(baseSha, headSha)) return { action: 'blocked', reason: 'invalid-pair' }
  const normalizedBaseSha = /** @type {string} */ (baseSha)
  const normalizedHeadSha = /** @type {string} */ (headSha)

  /** @type {RepairState} */
  let normalizedRepair
  try {
    normalizedRepair = normalizeRepairState(repair)
  } catch (error) {
    return {
      action: 'blocked',
      reason: 'invalid-repair-state',
      detail: error instanceof Error ? error.message : String(error),
      baseSha: normalizedBaseSha,
      headSha: normalizedHeadSha,
    }
  }
  if (normalizedRepair.active) {
    return {
      action: 'wait-repair',
      reason: 'repair-active',
      baseSha: normalizedBaseSha,
      headSha: normalizedHeadSha,
    }
  }

  const reviewStatus = currentReview(review, normalizedBaseSha, normalizedHeadSha)
  if (reviewStatus === 'missing') {
    return {
      action: 'request-review',
      reason: 'review-missing',
      baseSha: normalizedBaseSha,
      headSha: normalizedHeadSha,
    }
  }
  if (reviewStatus === 'pending') {
    return {
      action: 'wait-review',
      reason: 'review-pending',
      baseSha: normalizedBaseSha,
      headSha: normalizedHeadSha,
    }
  }
  if (reviewStatus === 'blocked') {
    return repairAvailable(normalizedRepair)
      ? {
          action: 'request-repair',
          reason: 'review-blocked',
          baseSha: normalizedBaseSha,
          headSha: normalizedHeadSha,
        }
      : {
          action: 'blocked',
          reason: 'repair-limit',
          baseSha: normalizedBaseSha,
          headSha: normalizedHeadSha,
        }
  }

  const ciStatus = currentCi(ci, normalizedHeadSha)
  if (ciStatus === 'pending') {
    return {
      action: 'wait-checks',
      reason: 'checks-pending',
      baseSha: normalizedBaseSha,
      headSha: normalizedHeadSha,
    }
  }
  if (ciStatus === 'failed') {
    return repairAvailable(normalizedRepair)
      ? {
          action: 'request-repair',
          reason: 'checks-failed',
          baseSha: normalizedBaseSha,
          headSha: normalizedHeadSha,
        }
      : {
          action: 'blocked',
          reason: 'repair-limit',
          baseSha: normalizedBaseSha,
          headSha: normalizedHeadSha,
        }
  }

  if (pullRequestRecord.mergeable === true) {
    return {
      action: 'request-merge',
      reason: 'ready',
      baseSha: normalizedBaseSha,
      headSha: normalizedHeadSha,
    }
  }
  if (pullRequestRecord.mergeable === null || pullRequestRecord.mergeable === undefined) {
    return {
      action: 'wait-mergeable',
      reason: 'mergeability-unknown',
      baseSha: normalizedBaseSha,
      headSha: normalizedHeadSha,
    }
  }
  if (pullRequestRecord.mergeable !== false) {
    return {
      action: 'blocked',
      reason: 'invalid-mergeability',
      baseSha: normalizedBaseSha,
      headSha: normalizedHeadSha,
    }
  }
  return repairAvailable(normalizedRepair)
    ? {
        action: 'request-repair',
        reason: 'merge-conflict',
        baseSha: normalizedBaseSha,
        headSha: normalizedHeadSha,
      }
    : {
        action: 'blocked',
        reason: 'repair-limit',
        baseSha: normalizedBaseSha,
        headSha: normalizedHeadSha,
      }
}
