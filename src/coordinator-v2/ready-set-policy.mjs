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

function exactObject(value, expected, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${name} must be an object`)
  }
  const fields = Object.keys(value).sort()
  if (fields.length !== expected.length || fields.some((field, index) => field !== expected[index])) {
    throw new Error(`${name} has missing or unknown fields`)
  }
}

function positiveIssueNumber(value, name = 'Issue number') {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_ISSUE_NUMBER) {
    throw new Error(`${name} must be a positive bounded integer`)
  }
  return value
}

function boundedLimit(value, name) {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_LIMIT) {
    throw new Error(`${name} must be an integer from 0 through ${MAX_LIMIT}`)
  }
  return value
}

function canonicalRepository(value) {
  if (typeof value !== 'string' || !REPOSITORY_PATTERN.test(value)) {
    throw new Error('Repository must use owner/name form')
  }
  return value.toLowerCase()
}

function canonicalTime(value) {
  if (typeof value !== 'string') throw new Error('Observation time must be a canonical UTC timestamp')
  const milliseconds = Date.parse(value)
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    throw new Error('Observation time must be a canonical UTC timestamp')
  }
  return value
}

function normalizeIssue(value) {
  exactObject(value, ISSUE_FIELDS, 'Issue observation')
  if (!['open', 'closed'].includes(value.state)) throw new Error('Issue state must be open or closed')
  if (!['issue', 'pull-request'].includes(value.type)) throw new Error('Issue type must be issue or pull-request')
  if (typeof value.body !== 'string' || Buffer.byteLength(value.body, 'utf8') > MAX_BODY_BYTES) {
    throw new Error('Issue body must be a bounded string')
  }
  if (typeof value.trustedAuthor !== 'boolean') throw new Error('Issue trustedAuthor must be boolean')
  return {
    body: value.body,
    number: positiveIssueNumber(value.number),
    state: value.state,
    trustedAuthor: value.trustedAuthor,
    type: value.type,
  }
}

function normalizePullRequest(value) {
  exactObject(value, PULL_REQUEST_FIELDS, 'Pull request observation')
  return {
    issueNumber: positiveIssueNumber(value.issueNumber, 'Pull request Issue number'),
    number: positiveIssueNumber(value.number, 'Pull request number'),
  }
}

function normalizeClaimObservation(value) {
  exactObject(value, CLAIM_FIELDS, 'Claim observation')
  if (value.authenticated !== true) throw new Error('Claim observation must be authenticated')
  return {
    authenticated: true,
    issueNumber: positiveIssueNumber(value.issueNumber, 'Claim Issue number'),
    projection: value.projection,
  }
}

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

function diagnostic(issueNumber, status, reason) {
  return { issueNumber, status, reason }
}

function selectAnyCurrentIssueClaim({ repository, issueNumber, observations, now }) {
  const authenticated = observations.filter(observation => observation?.authenticated === true)
  if (authenticated.length > MAX_CURRENT_CLAIMS_PER_ISSUE) {
    return { status: 'invalid', reason: 'invalid-observations' }
  }

  const current = new Map()
  const observedAt = Date.parse(now)
  for (const observation of authenticated) {
    let claim
    try {
      claim = parseTaskClaimProjection(observation.projection)
    } catch (error) {
      return { status: 'invalid', reason: 'malformed-authenticated-claim', detail: error.message }
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

function claimConsumesSlot(selection, observations) {
  if (selection.status === 'claimed') return true
  return selection.status !== 'claimable' && observations.length > 0
}

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
  let normalizedRepository
  let normalizedIssues
  let normalizedPullRequests
  let normalizedClaims
  let normalizedRequested
  let normalizedActiveLimit
  let normalizedBatchLimit
  let normalizedNow
  try {
    normalizedRepository = canonicalRepository(repository)
    if (!Array.isArray(issues) || issues.length > MAX_ISSUES) throw new Error('Issue observations are not bounded')
    if (!Array.isArray(pullRequests) || pullRequests.length > MAX_PULL_REQUESTS) {
      throw new Error('Pull request observations are not bounded')
    }
    if (!Array.isArray(claimObservations)) throw new Error('Claim observations must be an array')
    const authenticatedClaimObservations = claimObservations.filter(observation => observation?.authenticated === true)
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
    return invalidResult('invalid-input', error.message)
  }

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

  const pullRequestByNumber = new Map()
  const pullRequestConflictIssues = new Set()
  for (const pullRequest of normalizedPullRequests) {
    const previousIssue = pullRequestByNumber.get(pullRequest.number)
    if (previousIssue === undefined) pullRequestByNumber.set(pullRequest.number, pullRequest.issueNumber)
    else if (previousIssue !== pullRequest.issueNumber) {
      pullRequestConflictIssues.add(previousIssue)
      pullRequestConflictIssues.add(pullRequest.issueNumber)
    }
  }
  const pullRequestsByIssue = new Map()
  for (const [number, issueNumber] of pullRequestByNumber) {
    const set = pullRequestsByIssue.get(issueNumber) || new Set()
    set.add(number)
    pullRequestsByIssue.set(issueNumber, set)
  }

  const claimsByIssue = new Map()
  for (const claim of normalizedClaims) {
    const observations = claimsByIssue.get(claim.issueNumber) || []
    observations.push({ authenticated: true, projection: claim.projection })
    claimsByIssue.set(claim.issueNumber, observations)
  }

  let activeCount = 0
  const ready = []
  const diagnostics = new Map()
  const issueNumbers = [...issueGroups.keys()].sort((left, right) => left - right)

  for (const issueNumber of issueNumbers) {
    const variants = [...issueGroups.get(issueNumber).values()]
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
    const claimSelection = eligibility.taskId
      ? selectTaskClaim({
        repository: normalizedRepository,
        issueNumber,
        taskId: eligibility.taskId,
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
    if (eligibility.status !== 'ready') {
      diagnostics.set(issueNumber, diagnostic(issueNumber, eligibility.status, eligibility.reason))
      continue
    }

    ready.push({ issueNumber, taskId: eligibility.taskId })
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
