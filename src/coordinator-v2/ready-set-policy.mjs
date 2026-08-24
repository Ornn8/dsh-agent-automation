// @ts-check

import { decideTaskEligibility } from './task-policy.mjs'
import { parseTaskClaimProjection, selectTaskClaim } from './claim-policy.mjs'

const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const MAX_ISSUES = 512
const MAX_PULL_REQUESTS = 512
const MAX_CLAIM_OBSERVATIONS = 1_024
const MAX_CURRENT_CLAIMS_PER_ISSUE = 128
const MAX_LIMIT = 64
const MAX_BODY_BYTES = 64 * 1_024
const MAX_ISSUE_NUMBER = 2_147_483_647
const ISSUE_FIELDS = ['body', 'number', 'state', 'trustedAuthor', 'type']
const PULL_REQUEST_FIELDS = ['issueNumber', 'number']
const CLAIM_FIELDS = ['authenticated', 'issueNumber', 'projection']

/**
 * @typedef {{
 *   body: string,
 *   number: number,
 *   state: 'open' | 'closed',
 *   trustedAuthor: boolean,
 *   type: 'issue' | 'pull-request',
 * }} NormalizedIssueObservation
 */

/** @typedef {{ issueNumber: number, number: number }} NormalizedPullRequestObservation */
/** @typedef {{ authenticated: true, issueNumber: number, projection: unknown }} NormalizedClaimObservation */
/** @typedef {{ authenticated: true, projection: unknown }} ClaimInput */
/** @typedef {{ issueNumber: number, taskId: string }} ReadyTask */
/** @typedef {{ issueNumber: number, status: string, reason: string }} ReadySetDiagnostic */

/**
 * @typedef {{
 *   status: 'invalid',
 *   reason: string,
 *   detail?: string,
 *   selected: ReadyTask[],
 *   activeCount: 0,
 *   remainingSlots: 0,
 *   diagnostics: ReadySetDiagnostic[],
 * }} InvalidReadySetResult
 */

/**
 * @typedef {{
 *   status: 'ok',
 *   selected: ReadyTask[],
 *   activeCount: number,
 *   remainingSlots: number,
 *   diagnostics: ReadySetDiagnostic[],
 * }} ReadySetResult
 */

/** @typedef {InvalidReadySetResult | ReadySetResult} ReadySetDecision */

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
 * @param {unknown} error
 * @returns {string}
 */
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * @param {unknown} value
 * @param {string[]} expected
 * @param {string} name
 * @returns {Record<string, unknown>}
 */
function exactObject(value, expected, name) {
  const record = objectRecord(value)
  if (!record) throw new Error(`${name} must be an object`)
  const fields = Object.keys(record).sort()
  if (fields.length !== expected.length || fields.some((field, index) => field !== expected[index])) {
    throw new Error(`${name} has missing or unknown fields`)
  }
  return record
}

/**
 * @param {unknown} value
 * @param {string} [name]
 * @returns {number}
 */
function positiveIssueNumber(value, name = 'Issue number') {
  if (!Number.isSafeInteger(value) || /** @type {number} */ (value) < 1 || /** @type {number} */ (value) > MAX_ISSUE_NUMBER) {
    throw new Error(`${name} must be a positive bounded integer`)
  }
  return /** @type {number} */ (value)
}

/**
 * @param {unknown} value
 * @param {string} name
 * @returns {number}
 */
function boundedLimit(value, name) {
  if (!Number.isSafeInteger(value) || /** @type {number} */ (value) < 0 || /** @type {number} */ (value) > MAX_LIMIT) {
    throw new Error(`${name} must be an integer from 0 through ${MAX_LIMIT}`)
  }
  return /** @type {number} */ (value)
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function canonicalRepository(value) {
  if (typeof value !== 'string' || !REPOSITORY_PATTERN.test(value)) {
    throw new Error('Repository must use owner/name form')
  }
  return value.toLowerCase()
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function canonicalTime(value) {
  if (typeof value !== 'string') throw new Error('Observation time must be a canonical UTC timestamp')
  const milliseconds = Date.parse(value)
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    throw new Error('Observation time must be a canonical UTC timestamp')
  }
  return value
}

/**
 * @param {unknown} value
 * @returns {NormalizedIssueObservation}
 */
function normalizeIssue(value) {
  const record = exactObject(value, ISSUE_FIELDS, 'Issue observation')
  if (record.state !== 'open' && record.state !== 'closed') throw new Error('Issue state must be open or closed')
  if (record.type !== 'issue' && record.type !== 'pull-request') throw new Error('Issue type must be issue or pull-request')
  if (typeof record.body !== 'string' || Buffer.byteLength(record.body, 'utf8') > MAX_BODY_BYTES) {
    throw new Error('Issue body must be a bounded string')
  }
  if (typeof record.trustedAuthor !== 'boolean') throw new Error('Issue trustedAuthor must be boolean')
  return {
    body: record.body,
    number: positiveIssueNumber(record.number),
    state: record.state,
    trustedAuthor: record.trustedAuthor,
    type: record.type,
  }
}

/**
 * @param {unknown} value
 * @returns {NormalizedPullRequestObservation}
 */
function normalizePullRequest(value) {
  const record = exactObject(value, PULL_REQUEST_FIELDS, 'Pull request observation')
  return {
    issueNumber: positiveIssueNumber(record.issueNumber, 'Pull request Issue number'),
    number: positiveIssueNumber(record.number, 'Pull request number'),
  }
}

/**
 * @param {unknown} value
 * @returns {NormalizedClaimObservation}
 */
function normalizeClaimObservation(value) {
  const record = exactObject(value, CLAIM_FIELDS, 'Claim observation')
  if (record.authenticated !== true) throw new Error('Claim observation must be authenticated')
  return {
    authenticated: true,
    issueNumber: positiveIssueNumber(record.issueNumber, 'Claim Issue number'),
    projection: record.projection,
  }
}

/**
 * @param {string} reason
 * @param {string} [detail]
 * @returns {InvalidReadySetResult}
 */
function invalidResult(reason, detail) {
  return {
    status: 'invalid',
    reason,
    ...(detail ? { detail } : {}),
    selected: [],
    activeCount: 0,
    remainingSlots: 0,
    diagnostics: [],
  }
}

/**
 * @param {number} issueNumber
 * @param {string} status
 * @param {string} reason
 * @returns {ReadySetDiagnostic}
 */
function diagnostic(issueNumber, status, reason) {
  return { issueNumber, status, reason }
}

/**
 * @param {{ repository: string, issueNumber: number, observations: unknown[], now: string }} input
 * @returns {import('./claim-policy.mjs').TaskClaimSelection}
 */
function selectAnyCurrentIssueClaim({ repository, issueNumber, observations, now }) {
  const authenticated = observations.filter(observation => objectRecord(observation)?.authenticated === true)
  if (authenticated.length > MAX_CURRENT_CLAIMS_PER_ISSUE) {
    return { status: 'invalid', reason: 'invalid-observations' }
  }

  /** @type {Map<string, import('./claim-policy.mjs').ClaimProjection>} */
  const current = new Map()
  const observedAt = Date.parse(now)
  for (const observation of authenticated) {
    const record = /** @type {Record<string, unknown>} */ (observation)
    /** @type {import('./claim-policy.mjs').ClaimProjection} */
    let claim
    try {
      claim = parseTaskClaimProjection(record.projection)
    } catch (error) {
      return { status: 'invalid', reason: 'malformed-authenticated-claim', detail: errorMessage(error) }
    }
    if (claim.repository !== repository || claim.issueNumber !== issueNumber) {
      return { status: 'invalid', reason: 'claim-subject-mismatch', claimId: claim.claimId }
    }
    if (Date.parse(claim.createdAt) > observedAt) {
      return { status: 'invalid', reason: 'claim-created-in-future', claimId: claim.claimId }
    }
    if (Date.parse(claim.expiresAt) <= observedAt) continue
    current.set(claim.claimId, claim)
  }

  const claims = [...current.values()].sort((left, right) => left.claimId.localeCompare(right.claimId))
  if (claims.length === 0) return { status: 'claimable', reason: 'no-current-claim' }
  if (claims.length === 1) return { status: 'claimed', reason: 'current-claim', claim: claims[0] }
  return { status: 'conflict', reason: 'multiple-current-claims' }
}

/**
 * @param {import('./claim-policy.mjs').TaskClaimSelection} selection
 * @param {unknown[]} observations
 * @returns {boolean}
 */
function claimConsumesSlot(selection, observations) {
  if (selection.status === 'claimed') return true
  return selection.status !== 'claimable' && observations.length > 0
}

/**
 * @param {{ repository?: unknown, issues?: unknown, pullRequests?: unknown, claimObservations?: unknown, requestedIssueNumber?: unknown, activeLimit?: unknown, batchLimit?: unknown, now?: unknown }} [input]
 * @returns {ReadySetDecision}
 */
export function selectReadyTaskBatch({
  repository,
  issues = [],
  pullRequests = [],
  claimObservations = [],
  requestedIssueNumber,
  activeLimit,
  batchLimit,
  now,
} = {}) {
  /** @type {string} */
  let normalizedRepository
  /** @type {NormalizedIssueObservation[]} */
  let normalizedIssues
  /** @type {NormalizedPullRequestObservation[]} */
  let normalizedPullRequests
  /** @type {NormalizedClaimObservation[]} */
  let normalizedClaims
  /** @type {number | null} */
  let normalizedRequested
  /** @type {number} */
  let normalizedActiveLimit
  /** @type {number} */
  let normalizedBatchLimit
  /** @type {string} */
  let normalizedNow
  try {
    normalizedRepository = canonicalRepository(repository)
    if (!Array.isArray(issues) || issues.length > MAX_ISSUES) throw new Error('Issue observations are not bounded')
    if (!Array.isArray(pullRequests) || pullRequests.length > MAX_PULL_REQUESTS) {
      throw new Error('Pull request observations are not bounded')
    }
    if (!Array.isArray(claimObservations)) throw new Error('Claim observations must be an array')
    const authenticatedClaimObservations = claimObservations.filter(observation => objectRecord(observation)?.authenticated === true)
    if (authenticatedClaimObservations.length > MAX_CLAIM_OBSERVATIONS) {
      throw new Error('Authenticated claim observations are not bounded')
    }
    normalizedIssues = issues.map(normalizeIssue)
    normalizedPullRequests = pullRequests.map(normalizePullRequest)
    normalizedClaims = authenticatedClaimObservations.map(normalizeClaimObservation)
    normalizedRequested = requestedIssueNumber === undefined || requestedIssueNumber === null
      ? null
      : positiveIssueNumber(requestedIssueNumber, 'Requested Issue number')
    normalizedActiveLimit = boundedLimit(activeLimit, 'Active limit')
    normalizedBatchLimit = boundedLimit(batchLimit, 'Batch limit')
    normalizedNow = canonicalTime(now)
  } catch (error) {
    return invalidResult('invalid-input', errorMessage(error))
  }

  /** @type {Map<number, Map<string, NormalizedIssueObservation>>} */
  const issueGroups = new Map()
  for (const issue of normalizedIssues) {
    const group = issueGroups.get(issue.number) || new Map()
    group.set(JSON.stringify(issue), issue)
    issueGroups.set(issue.number, group)
  }
  for (const pullRequest of normalizedPullRequests) {
    if (!issueGroups.has(pullRequest.issueNumber)) {
      return invalidResult('incomplete-issue-snapshot', `Pull request #${pullRequest.number} has no Issue observation`)
    }
  }
  for (const claim of normalizedClaims) {
    if (!issueGroups.has(claim.issueNumber)) {
      return invalidResult('incomplete-issue-snapshot', `Authenticated claim has no Issue observation for #${claim.issueNumber}`)
    }
  }

  const dependencyObservations = normalizedIssues.map(issue => ({
    number: issue.number,
    state: issue.state,
    type: issue.type,
  }))

  /** @type {Map<number, number>} */
  const pullRequestByNumber = new Map()
  /** @type {Set<number>} */
  const pullRequestConflictIssues = new Set()
  for (const pullRequest of normalizedPullRequests) {
    const previousIssue = pullRequestByNumber.get(pullRequest.number)
    if (previousIssue === undefined) pullRequestByNumber.set(pullRequest.number, pullRequest.issueNumber)
    else if (previousIssue !== pullRequest.issueNumber) {
      pullRequestConflictIssues.add(previousIssue)
      pullRequestConflictIssues.add(pullRequest.issueNumber)
    }
  }
  /** @type {Map<number, Set<number>>} */
  const pullRequestsByIssue = new Map()
  for (const [number, issueNumber] of pullRequestByNumber) {
    const set = pullRequestsByIssue.get(issueNumber) || new Set()
    set.add(number)
    pullRequestsByIssue.set(issueNumber, set)
  }

  /** @type {Map<number, ClaimInput[]>} */
  const claimsByIssue = new Map()
  for (const claim of normalizedClaims) {
    const observations = claimsByIssue.get(claim.issueNumber) || []
    observations.push({ authenticated: true, projection: claim.projection })
    claimsByIssue.set(claim.issueNumber, observations)
  }

  let activeCount = 0
  /** @type {ReadyTask[]} */
  const ready = []
  /** @type {Map<number, ReadySetDiagnostic>} */
  const diagnostics = new Map()
  const issueNumbers = [...issueGroups.keys()].sort((left, right) => left - right)

  for (const issueNumber of issueNumbers) {
    const group = issueGroups.get(issueNumber)
    if (!group) continue
    const variants = [...group.values()]
    const openPullRequests = pullRequestsByIssue.get(issueNumber) || new Set()
    const claimInputs = claimsByIssue.get(issueNumber) || []
    const issue = variants.length === 1 ? variants[0] : null
    const eligibility = issue?.type === 'issue'
      ? decideTaskEligibility({
        repository: normalizedRepository,
        issue,
        trustedAuthor: issue.trustedAuthor,
        dependencies: dependencyObservations,
        hasOpenPullRequest: false,
      })
      : { status: 'ineligible', reason: issue ? 'not-issue' : 'issue-observation-conflict' }
    const eligibilityTaskId = 'taskId' in eligibility && typeof eligibility.taskId === 'string'
      ? eligibility.taskId
      : null
    const claimSelection = eligibilityTaskId
      ? selectTaskClaim({
        repository: normalizedRepository,
        issueNumber,
        taskId: eligibilityTaskId,
        observations: claimInputs,
        now: normalizedNow,
      })
      : selectAnyCurrentIssueClaim({
        repository: normalizedRepository,
        issueNumber,
        observations: claimInputs,
        now: normalizedNow,
      })
    const currentClaimConsumesSlot = claimConsumesSlot(claimSelection, claimInputs)

    if (variants.length !== 1) {
      if (openPullRequests.size > 0 || currentClaimConsumesSlot) activeCount += 1
      diagnostics.set(issueNumber, diagnostic(issueNumber, 'invalid', 'issue-observation-conflict'))
      continue
    }
    if (pullRequestConflictIssues.has(issueNumber) || openPullRequests.size > 1) {
      if (openPullRequests.size > 0 || currentClaimConsumesSlot) activeCount += 1
      diagnostics.set(issueNumber, diagnostic(issueNumber, 'invalid', 'pull-request-conflict'))
      continue
    }
    if (openPullRequests.size === 1) {
      activeCount += 1
      diagnostics.set(issueNumber, diagnostic(issueNumber, 'active', 'open-pull-request'))
      continue
    }
    if (claimSelection.status === 'claimed') {
      activeCount += 1
      diagnostics.set(issueNumber, diagnostic(issueNumber, 'active', 'current-claim'))
      continue
    }
    if (claimSelection.status !== 'claimable') {
      if (currentClaimConsumesSlot) activeCount += 1
      diagnostics.set(issueNumber, diagnostic(issueNumber, 'invalid', claimSelection.reason))
      continue
    }
    if (eligibility.status !== 'ready' || !eligibilityTaskId) {
      diagnostics.set(issueNumber, diagnostic(issueNumber, eligibility.status, eligibility.reason))
      continue
    }

    ready.push({ issueNumber, taskId: eligibilityTaskId })
    diagnostics.set(issueNumber, diagnostic(issueNumber, 'ready', 'eligible'))
  }

  const remainingSlots = Math.max(0, normalizedActiveLimit - activeCount)
  ready.sort((left, right) => {
    const leftRequested = left.issueNumber === normalizedRequested
    const rightRequested = right.issueNumber === normalizedRequested
    if (leftRequested !== rightRequested) return leftRequested ? -1 : 1
    return left.issueNumber - right.issueNumber
  })

  const selectionLimit = Math.min(remainingSlots, normalizedBatchLimit)
  const selected = ready.slice(0, selectionLimit)
  const selectedNumbers = new Set(selected.map(task => task.issueNumber))
  const deferredReason = remainingSlots <= normalizedBatchLimit ? 'repository-limit' : 'batch-limit'
  for (const task of ready) {
    diagnostics.set(task.issueNumber, selectedNumbers.has(task.issueNumber)
      ? diagnostic(task.issueNumber, 'selected', 'selected')
      : diagnostic(task.issueNumber, 'deferred', deferredReason))
  }

  return {
    status: 'ok',
    selected,
    activeCount,
    remainingSlots,
    diagnostics: [...diagnostics.values()].sort((left, right) => left.issueNumber - right.issueNumber),
  }
}
