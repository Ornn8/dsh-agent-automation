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

function positiveIssueNumber(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_ISSUE_NUMBER) {
    throw new Error('Issue number must be a positive bounded integer')
  }
  return value
}

function repositoryName(value) {
  if (typeof value !== 'string' || !REPOSITORY_PATTERN.test(value)) {
    throw new Error('Repository must use owner/name form')
  }
  return value.toLowerCase()
}

function taskIdentity(value) {
  if (typeof value !== 'string' || !TASK_ID_PATTERN.test(value)) {
    throw new Error('Task id must be a Coordinator V2 task identity')
  }
  return value
}

function claimantIdentity(value) {
  if (typeof value !== 'string' || !CLAIMANT_PATTERN.test(value)) {
    throw new Error('Claimant must be a bounded runtime identity')
  }
  return value
}

function timestamp(value, name) {
  if (typeof value !== 'string') throw new Error(`${name} must be a canonical UTC timestamp`)
  const milliseconds = Date.parse(value)
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    throw new Error(`${name} must be a canonical UTC timestamp`)
  }
  return { value, milliseconds }
}

function generatedClaimId(value) {
  const canonical = JSON.stringify({ protocol: PROTOCOL, ...value })
  return `claim-${createHash('sha256').update(canonical).digest('hex')}`
}

function normalizedProjection(value, requireClaimId = true) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Claim projection must be an object')
  }
  const fields = Object.keys(value).sort()
  const expected = requireClaimId ? PROJECTION_FIELDS : PROJECTION_FIELDS.filter(field => field !== 'claimId')
  if (fields.length !== expected.length || fields.some((field, index) => field !== expected[index])) {
    throw new Error('Claim projection has missing or unknown fields')
  }
  if (value.version !== 1) throw new Error('Claim projection version must be 1')

  const createdAt = timestamp(value.createdAt, 'createdAt')
  const expiresAt = timestamp(value.expiresAt, 'expiresAt')
  const duration = expiresAt.milliseconds - createdAt.milliseconds
  if (duration < MIN_CLAIM_MS || duration > MAX_CLAIM_MS) {
    throw new Error('Claim duration is outside the bounded range')
  }

  const core = {
    version: 1,
    repository: repositoryName(value.repository),
    issueNumber: positiveIssueNumber(value.issueNumber),
    taskId: taskIdentity(value.taskId),
    claimant: claimantIdentity(value.claimant),
    createdAt: createdAt.value,
    expiresAt: expiresAt.value,
  }
  const claimId = generatedClaimId(core)
  if (requireClaimId && (typeof value.claimId !== 'string' || !CLAIM_ID_PATTERN.test(value.claimId) || value.claimId !== claimId)) {
    throw new Error('Claim id does not match the projection')
  }
  return { claimId, ...core }
}

export function createTaskClaim({ repository, issueNumber, taskId, claimant, now, leaseMs }) {
  if (!Number.isSafeInteger(leaseMs) || leaseMs < MIN_CLAIM_MS || leaseMs > MAX_CLAIM_MS) {
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
    expiresAt: new Date(createdAt.milliseconds + leaseMs).toISOString(),
  }, false)
}

export function parseTaskClaimProjection(value) {
  return normalizedProjection(value)
}

export function selectTaskClaim({ repository, issueNumber, taskId, observations = [], now }) {
  let subject
  let observedAt
  try {
    subject = { repository: repositoryName(repository), issueNumber: positiveIssueNumber(issueNumber), taskId: taskIdentity(taskId) }
    observedAt = timestamp(now, 'now')
  } catch (error) {
    return { status: 'invalid', reason: 'invalid-subject', detail: error.message }
  }
  if (!Array.isArray(observations)) {
    return { status: 'invalid', reason: 'invalid-observations' }
  }
  const authenticatedObservations = observations.filter(observation => observation?.authenticated === true)
  if (authenticatedObservations.length > MAX_OBSERVATIONS) {
    return { status: 'invalid', reason: 'invalid-observations' }
  }

  const current = new Map()
  for (const observation of authenticatedObservations) {
    const fields = Object.keys(observation).sort()
    if (fields.length !== 2 || fields[0] !== 'authenticated' || fields[1] !== 'projection') {
      return { status: 'invalid', reason: 'malformed-authenticated-claim' }
    }

    let claim
    try {
      claim = parseTaskClaimProjection(observation.projection)
    } catch (error) {
      return { status: 'invalid', reason: 'malformed-authenticated-claim', detail: error.message }
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
  if (eligibility?.status !== 'ready' || eligibility.taskId !== taskId) {
    return { action: 'ineligible', reason: 'task-not-ready' }
  }

  let subject
  let normalizedClaimant
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
    return { action: 'blocked', reason: 'invalid-claim-request', detail: error.message }
  }

  if (selection?.status === 'invalid' || selection?.status === 'conflict') {
    return { action: 'blocked', reason: selection.reason || 'invalid-claim-selection' }
  }
  if (selection?.status === 'claimed') {
    let claim
    try {
      claim = parseTaskClaimProjection(selection.claim)
    } catch (error) {
      return { action: 'blocked', reason: 'invalid-claim-selection', detail: error.message }
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
  if (selection?.status !== 'claimable') return { action: 'blocked', reason: 'invalid-claim-selection' }

  try {
    const claim = createTaskClaim({ ...subject, claimant: normalizedClaimant, now: observedAt.value, leaseMs })
    return { action: 'create', reason: 'claimable', claim }
  } catch (error) {
    return { action: 'blocked', reason: 'invalid-claim-request', detail: error.message }
  }
}
