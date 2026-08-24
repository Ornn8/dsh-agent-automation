// @ts-check

import { createHash } from 'node:crypto'

const PROTOCOL = 'agent-task-claim:v1'
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const TASK_ID_PATTERN = /^task-[0-9a-f]{64}$/
const CLAIM_ID_PATTERN = /^claim-[0-9a-f]{64}$/
const CLAIMANT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/
const MAX_ISSUE_NUMBER = 2_147_483_647
const MIN_CLAIM_MS = 60_000
const MAX_CLAIM_MS = 6 * 60 * 60 * 1_000
const MAX_OBSERVATIONS = 128
const PROJECTION_FIELDS = [
  'claimId',
  'claimant',
  'createdAt',
  'expiresAt',
  'issueNumber',
  'repository',
  'taskId',
  'version',
]

/**
 * @typedef {{
 *   version: 1,
 *   repository: string,
 *   issueNumber: number,
 *   taskId: string,
 *   claimant: string,
 *   createdAt: string,
 *   expiresAt: string,
 * }} ClaimCore
 */

/** @typedef {ClaimCore & { claimId: string }} ClaimProjection */
/** @typedef {{ value: string, milliseconds: number }} CanonicalTimestamp */

/**
 * @typedef {{
 *   status: 'invalid' | 'claimable' | 'claimed' | 'conflict',
 *   reason: string,
 *   detail?: string,
 *   claimId?: string,
 *   claim?: ClaimProjection,
 *   claimCount?: number,
 *   claimIds?: string[],
 * }} TaskClaimSelection
 */

/**
 * @typedef {{
 *   action: 'ineligible' | 'blocked' | 'existing' | 'busy' | 'create',
 *   reason: string,
 *   detail?: string,
 *   claimId?: string,
 *   claim?: ClaimProjection,
 * }} ClaimAcquisitionDecision
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
 * Detect the authentication assertion before validating the ordinary-record shape.
 * Functions can carry properties in-process, so an authenticated function is malformed
 * authority rather than unauthenticated noise.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
function declaresAuthentication(value) {
  if ((typeof value !== 'object' || value === null) && typeof value !== 'function') return false
  return /** @type {{ authenticated?: unknown }} */ (value).authenticated === true
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * @param {unknown} value
 * @returns {number}
 */
function positiveIssueNumber(value) {
  if (!Number.isSafeInteger(value) || /** @type {number} */ (value) < 1 || /** @type {number} */ (value) > MAX_ISSUE_NUMBER) {
    throw new Error('Issue number must be a positive bounded integer')
  }
  return /** @type {number} */ (value)
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function repositoryName(value) {
  if (typeof value !== 'string' || !REPOSITORY_PATTERN.test(value)) {
    throw new Error('Repository must use owner/name form')
  }
  return value.toLowerCase()
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function taskIdentity(value) {
  if (typeof value !== 'string' || !TASK_ID_PATTERN.test(value)) {
    throw new Error('Task id must be a Coordinator V2 task identity')
  }
  return value
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function claimantIdentity(value) {
  if (typeof value !== 'string' || !CLAIMANT_PATTERN.test(value)) {
    throw new Error('Claimant must be a bounded runtime identity')
  }
  return value
}

/**
 * @param {unknown} value
 * @param {string} name
 * @returns {CanonicalTimestamp}
 */
function timestamp(value, name) {
  if (typeof value !== 'string') throw new Error(`${name} must be a canonical UTC timestamp`)
  const milliseconds = Date.parse(value)
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    throw new Error(`${name} must be a canonical UTC timestamp`)
  }
  return { value, milliseconds }
}

/**
 * @param {ClaimCore} value
 * @returns {string}
 */
function generatedClaimId(value) {
  const canonical = JSON.stringify({ protocol: PROTOCOL, ...value })
  return `claim-${createHash('sha256').update(canonical).digest('hex')}`
}

/**
 * @param {unknown} value
 * @param {boolean} [requireClaimId]
 * @returns {ClaimProjection}
 */
function normalizedProjection(value, requireClaimId = true) {
  const record = objectRecord(value)
  if (!record) throw new Error('Claim projection must be an object')

  const fields = Object.keys(record).sort()
  const expected = requireClaimId ? PROJECTION_FIELDS : PROJECTION_FIELDS.filter(field => field !== 'claimId')
  if (fields.length !== expected.length || fields.some((field, index) => field !== expected[index])) {
    throw new Error('Claim projection has missing or unknown fields')
  }
  if (record.version !== 1) throw new Error('Claim projection version must be 1')

  const createdAt = timestamp(record.createdAt, 'createdAt')
  const expiresAt = timestamp(record.expiresAt, 'expiresAt')
  const duration = expiresAt.milliseconds - createdAt.milliseconds
  if (duration < MIN_CLAIM_MS || duration > MAX_CLAIM_MS) {
    throw new Error('Claim duration is outside the bounded range')
  }

  /** @type {ClaimCore} */
  const core = {
    version: 1,
    repository: repositoryName(record.repository),
    issueNumber: positiveIssueNumber(record.issueNumber),
    taskId: taskIdentity(record.taskId),
    claimant: claimantIdentity(record.claimant),
    createdAt: createdAt.value,
    expiresAt: expiresAt.value,
  }
  const claimId = generatedClaimId(core)
  if (requireClaimId && (typeof record.claimId !== 'string' || !CLAIM_ID_PATTERN.test(record.claimId) || record.claimId !== claimId)) {
    throw new Error('Claim id does not match the projection')
  }
  return { claimId, ...core }
}

/**
 * @param {{ repository?: unknown, issueNumber?: unknown, taskId?: unknown, claimant?: unknown, now?: unknown, leaseMs?: unknown }} input
 * @returns {ClaimProjection}
 */
export function createTaskClaim({ repository, issueNumber, taskId, claimant, now, leaseMs }) {
  if (!Number.isSafeInteger(leaseMs) || /** @type {number} */ (leaseMs) < MIN_CLAIM_MS || /** @type {number} */ (leaseMs) > MAX_CLAIM_MS) {
    throw new Error('Claim lease must be a bounded integer')
  }
  const createdAt = timestamp(now, 'now')
  return normalizedProjection({
    version: 1,
    repository,
    issueNumber,
    taskId,
    claimant,
    createdAt: createdAt.value,
    expiresAt: new Date(createdAt.milliseconds + /** @type {number} */ (leaseMs)).toISOString(),
  }, false)
}

/**
 * @param {unknown} value
 * @returns {ClaimProjection}
 */
export function parseTaskClaimProjection(value) {
  return normalizedProjection(value)
}

/**
 * @param {{ repository?: unknown, issueNumber?: unknown, taskId?: unknown, observations?: unknown, now?: unknown }} input
 * @returns {TaskClaimSelection}
 */
export function selectTaskClaim({ repository, issueNumber, taskId, observations = [], now }) {
  /** @type {{ repository: string, issueNumber: number, taskId: string }} */
  let subject
  /** @type {CanonicalTimestamp} */
  let observedAt
  try {
    subject = {
      repository: repositoryName(repository),
      issueNumber: positiveIssueNumber(issueNumber),
      taskId: taskIdentity(taskId),
    }
    observedAt = timestamp(now, 'now')
  } catch (error) {
    return { status: 'invalid', reason: 'invalid-subject', detail: errorMessage(error) }
  }
  if (!Array.isArray(observations)) {
    return { status: 'invalid', reason: 'invalid-observations' }
  }
  const authenticatedObservations = observations.filter(declaresAuthentication)
  if (authenticatedObservations.length > MAX_OBSERVATIONS) {
    return { status: 'invalid', reason: 'invalid-observations' }
  }

  /** @type {Map<string, ClaimProjection>} */
  const current = new Map()
  for (const observation of authenticatedObservations) {
    const record = objectRecord(observation)
    if (!record) return { status: 'invalid', reason: 'malformed-authenticated-claim' }

    const fields = Object.keys(record).sort()
    if (fields.length !== 2 || fields[0] !== 'authenticated' || fields[1] !== 'projection') {
      return { status: 'invalid', reason: 'malformed-authenticated-claim' }
    }

    /** @type {ClaimProjection} */
    let claim
    try {
      claim = parseTaskClaimProjection(record.projection)
    } catch (error) {
      return { status: 'invalid', reason: 'malformed-authenticated-claim', detail: errorMessage(error) }
    }
    if (claim.repository !== subject.repository || claim.issueNumber !== subject.issueNumber) {
      return { status: 'invalid', reason: 'claim-subject-mismatch', claimId: claim.claimId }
    }
    if (claim.taskId !== subject.taskId) continue

    const createdAt = Date.parse(claim.createdAt)
    const expiresAt = Date.parse(claim.expiresAt)
    if (createdAt > observedAt.milliseconds) {
      return { status: 'invalid', reason: 'claim-created-in-future', claimId: claim.claimId }
    }
    if (expiresAt <= observedAt.milliseconds) continue
    current.set(claim.claimId, claim)
  }

  const claims = [...current.values()].sort((left, right) => left.claimId.localeCompare(right.claimId))
  if (claims.length === 0) return { status: 'claimable', reason: 'no-current-claim' }
  if (claims.length === 1) return { status: 'claimed', reason: 'current-claim', claim: claims[0] }
  return {
    status: 'conflict',
    reason: 'multiple-current-claims',
    claimCount: claims.length,
    claimIds: claims.slice(0, 8).map(claim => claim.claimId),
  }
}

/**
 * @param {{ eligibility?: unknown, selection?: unknown, repository?: unknown, issueNumber?: unknown, taskId?: unknown, claimant?: unknown, now?: unknown, leaseMs?: unknown }} input
 * @returns {ClaimAcquisitionDecision}
 */
export function decideClaimAcquisition({
  eligibility,
  selection,
  repository,
  issueNumber,
  taskId,
  claimant,
  now,
  leaseMs,
}) {
  const eligibilityRecord = objectRecord(eligibility)
  if (!eligibilityRecord || eligibilityRecord.status !== 'ready' || eligibilityRecord.taskId !== taskId) {
    return { action: 'ineligible', reason: 'task-not-ready' }
  }

  /** @type {{ repository: string, issueNumber: number, taskId: string }} */
  let subject
  /** @type {string} */
  let normalizedClaimant
  /** @type {CanonicalTimestamp} */
  let observedAt
  try {
    subject = {
      repository: repositoryName(repository),
      issueNumber: positiveIssueNumber(issueNumber),
      taskId: taskIdentity(taskId),
    }
    normalizedClaimant = claimantIdentity(claimant)
    observedAt = timestamp(now, 'now')
  } catch (error) {
    return { action: 'blocked', reason: 'invalid-claim-request', detail: errorMessage(error) }
  }

  const selectionRecord = objectRecord(selection)
  if (!selectionRecord) return { action: 'blocked', reason: 'invalid-claim-selection' }
  if (selectionRecord.status === 'invalid' || selectionRecord.status === 'conflict') {
    return {
      action: 'blocked',
      reason: typeof selectionRecord.reason === 'string' && selectionRecord.reason
        ? selectionRecord.reason
        : 'invalid-claim-selection',
    }
  }
  if (selectionRecord.status === 'claimed') {
    /** @type {ClaimProjection} */
    let claim
    try {
      claim = parseTaskClaimProjection(selectionRecord.claim)
    } catch (error) {
      return { action: 'blocked', reason: 'invalid-claim-selection', detail: errorMessage(error) }
    }
    if (claim.repository !== subject.repository || claim.issueNumber !== subject.issueNumber || claim.taskId !== subject.taskId) {
      return { action: 'blocked', reason: 'claim-subject-mismatch' }
    }
    if (Date.parse(claim.createdAt) > observedAt.milliseconds || Date.parse(claim.expiresAt) <= observedAt.milliseconds) {
      return { action: 'blocked', reason: 'claim-selection-stale' }
    }
    return claim.claimant === normalizedClaimant
      ? { action: 'existing', reason: 'same-claimant', claim }
      : { action: 'busy', reason: 'claimed-by-another-runtime', claimId: claim.claimId }
  }
  if (selectionRecord.status !== 'claimable') {
    return { action: 'blocked', reason: 'invalid-claim-selection' }
  }

  try {
    const claim = createTaskClaim({ ...subject, claimant: normalizedClaimant, now: observedAt.value, leaseMs })
    return { action: 'create', reason: 'claimable', claim }
  } catch (error) {
    return { action: 'blocked', reason: 'invalid-claim-request', detail: errorMessage(error) }
  }
}
