import { createHash } from 'node:crypto'
import { resolveGithubPrCycle } from './github-pr-cycle.mjs'
import { workflowDefinitionHash } from './workflow-definition.mjs'
import { resolveIssueEntryStage, resolveWorkflowStage } from './workflow-profile.mjs'

const FULL_SHA = /^[0-9a-f]{40}$/
const SHA256 = /^[0-9a-f]{64}$/
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const ALLOWED_FIELDS = new Set([
  'version', 'requestId', 'profileId', 'workflowId', 'stageId', 'definitionHash',
  'role', 'repository', 'subject', 'revision', 'coordinationKey',
])

function requiredText(value, name, maximum = 300) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > maximum || /[\r\n]/.test(value)) {
    throw new Error(`${name} must be non-empty one-line text of at most ${maximum} characters`)
  }
  return value.trim()
}

function identifier(value, name) {
  const text = requiredText(value, name, 64)
  if (!ID.test(text)) throw new Error(`${name} must be an identifier`)
  return text
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function generatedRequestId(value) {
  return `work-${createHash('sha256').update(canonicalJson(value)).digest('hex').slice(0, 40)}`
}

function reviewObservationId(value) {
  const text = requiredText(value, 'review repair observation id', 72)
  if (!/^(?:run-[1-9][0-9]{0,19}|comment-[1-9][0-9]{0,19}|advance-[0-9a-f]{64}|a-[A-Za-z0-9_-]{43})$/.test(text)) {
    throw new Error('review repair observation id must identify one trusted review run or advancement transition')
  }
  return text
}

/** Return a compact, lossless encoding of one SHA-256 advancement identity. */
export function advancementRepairObservationId(identity) {
  if (!SHA256.test(identity || '')) throw new Error('advancement repair identity must be a SHA-256 digest')
  return `a-${Buffer.from(identity, 'hex').toString('base64url')}`
}

/** Return the distinct Governor transition for one authoritative review generation. */
export function reviewRepairTransition(observationId) {
  return `review-repair:${reviewObservationId(observationId)}`
}

/** Return the distinct Governor transition for one authoritative merge-repair generation. */
export function mergeRepairTransition(observationId) {
  return `merge-repair:${reviewObservationId(observationId)}`
}

/** Return the safe durable request id for one blocked review generation. */
export function reviewRepairRequestId(head, observationId) {
  if (!FULL_SHA.test(head)) throw new Error('review repair request id requires a full lowercase head SHA')
  return `review-repair-${head}-${reviewObservationId(observationId)}`
}

/** Return whether a request id binds the supplied exact review head and one review generation. */
export function isReviewRepairRequestId(value, expectedHead) {
  const match = /^review-repair-([0-9a-f]{40})-((?:run-[1-9][0-9]{0,19}|comment-[1-9][0-9]{0,19}|advance-[0-9a-f]{64}|a-[A-Za-z0-9_-]{43}))$/.exec(String(value || ''))
  return Boolean(match && FULL_SHA.test(expectedHead) && match[1] === expectedHead)
}

/** Validate and return one immutable WorkRequest. */
export function parseAgentWorkRequest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== 2) {
    throw new Error('WorkRequest version must be 2')
  }
  for (const key of Object.keys(value)) {
    if (!ALLOWED_FIELDS.has(key)) throw new Error(`WorkRequest has unknown field ${key}`)
  }
  for (const key of ALLOWED_FIELDS) {
    if (!Object.hasOwn(value, key)) throw new Error(`WorkRequest is missing required field ${key}`)
  }

  const requestId = requiredText(value.requestId, 'WorkRequest requestId', 160)
  const profileId = identifier(value.profileId, 'WorkRequest profileId')
  const workflowId = identifier(value.workflowId, 'WorkRequest workflowId')
  const stageId = identifier(value.stageId, 'WorkRequest stageId')
  const role = identifier(value.role, 'WorkRequest role')
  const repository = requiredText(value.repository, 'WorkRequest repository', 200)
  const coordinationKey = requiredText(value.coordinationKey, 'WorkRequest coordinationKey')
  if (!SHA256.test(value.definitionHash || '')) throw new Error('WorkRequest definitionHash must be a SHA-256 digest')
  if (!REPOSITORY.test(repository)) throw new Error('WorkRequest repository is invalid')
  if (!['issue', 'pull-request'].includes(value.subject?.type)
    || !Number.isSafeInteger(value.subject.number)
    || value.subject.number < 1
    || Object.keys(value.subject).length !== 2) {
    throw new Error('WorkRequest subject must identify an issue or pull request')
  }
  if (!FULL_SHA.test(value.revision?.base) || !FULL_SHA.test(value.revision?.head)
    || Object.keys(value.revision).length !== 2) {
    throw new Error('WorkRequest revision must contain full lowercase commit SHAs')
  }
  return {
    version: 2,
    requestId,
    profileId,
    workflowId,
    stageId,
    definitionHash: value.definitionHash,
    role,
    repository,
    subject: { type: value.subject.type, number: value.subject.number },
    revision: { base: value.revision.base, head: value.revision.head },
    coordinationKey,
  }
}

/** Create one WorkRequest after resolving its worker Stage from a trusted Profile. */
export function createStageWorkRequest({
  definition,
  definitionHash,
  workflowId,
  stageId,
  repository,
  subject,
  revision,
  coordinationKey,
  requestId,
}) {
  const actualHash = workflowDefinitionHash(definition)
  if (definitionHash !== actualHash) throw new Error('WorkRequest definitionHash does not match the Profile')
  const stage = resolveWorkflowStage(definition, workflowId, stageId, 'worker')
  const unsigned = {
    version: 2,
    profileId: definition.profileId,
    workflowId,
    stageId,
    definitionHash,
    role: stage.role,
    repository,
    subject,
    revision,
    coordinationKey,
  }
  return parseAgentWorkRequest({
    ...unsigned,
    requestId: requestId || generatedRequestId(unsigned),
  })
}

/** Create the root worker request selected by one ready Issue declaration. */
export function createIssueImplementationRequest({
  definition,
  definitionHash,
  workflowId,
  repository,
  issueNumber,
  base,
  requestId,
}) {
  const stage = resolveIssueEntryStage(definition, workflowId)
  return createStageWorkRequest({
    definition,
    definitionHash,
    workflowId,
    stageId: stage.id,
    repository,
    subject: { type: 'issue', number: issueNumber },
    revision: { base, head: base },
    coordinationKey: `${repository}:${definition.profileId}:${workflowId}`,
    requestId,
  })
}

/** Resolve the single trusted pull-request repair Worker Stage from a Profile. */
export function resolveRepairEntryStage(definition) {
  const candidates = Object.entries(definition?.workflows || {}).filter(([, workflow]) =>
    workflow.stages.some(stage => stage.uses === 'worker' && stage.procedure === 'github-pr-repair'))
  if (candidates.length !== 1) throw new Error('Profile must define exactly one github-pr-repair workflow')
  const [workflowId] = candidates[0]
  const { change: stage } = resolveGithubPrCycle(definition, workflowId)
  if (stage.role !== 'change') throw new Error('github-pr-repair Stage must use the change role')
  return { workflowId, stage }
}

/** Create a trusted Profile's root pull-request repair request. */
export function createReviewRepairRequest({
  definition,
  definitionHash,
  repository,
  pullRequestNumber,
  base,
  head,
  reviewObservationId,
}) {
  const { workflowId, stage } = resolveRepairEntryStage(definition)
  return createStageWorkRequest({
    definition,
    definitionHash,
    workflowId,
    stageId: stage.id,
    repository,
    subject: { type: 'pull-request', number: pullRequestNumber },
    revision: { base, head },
    coordinationKey: `${repository}:${definition.profileId}:${workflowId}`,
    requestId: reviewRepairRequestId(head, reviewObservationId),
  })
}

/** Wrap a validated WorkRequest for GitHub repository_dispatch transport. */
export function repositoryDispatchBody(request) {
  const workRequest = parseAgentWorkRequest(request)
  return {
    event_type: 'agent_work_requested',
    client_payload: { work_request: workRequest },
  }
}
