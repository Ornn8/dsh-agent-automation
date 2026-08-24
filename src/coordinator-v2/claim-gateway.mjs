// @ts-check

import { decideClaimAcquisition, selectTaskClaim } from './claim-policy.mjs'
import {
  parseClaimComment,
  renderClaimComment,
  selectClaimCommentObservation,
} from './claim-comment.mjs'
import { decideTaskEligibility } from './task-policy.mjs'

const MAX_RAW_COMMENTS = 10_000
const REQUEST_FIELDS = ['claimant', 'expectedTaskId', 'issueNumber', 'repository']
const CONFIG_FIELDS = ['author', 'controller', 'leaseMs', 'now', 'source']
const GATEWAY_FIELDS = ['createComment', 'loadRun', 'readTaskSnapshot', 'updateComment']

/** @typedef {import('./claim-policy.mjs').ClaimProjection} ClaimProjection */
/** @typedef {import('./claim-comment.mjs').AppAuthor} AppAuthor */
/** @typedef {import('./claim-comment.mjs').ControllerProvenance} ControllerProvenance */
/** @typedef {import('./claim-comment.mjs').ClaimSource} ClaimSource */
/** @typedef {import('./claim-comment.mjs').ClaimCommentExpectation} ClaimCommentExpectation */
/** @typedef {import('./claim-comment.mjs').ClaimCommentRecord} ClaimCommentRecord */
/** @typedef {import('./claim-comment.mjs').SourceRunLoader} SourceRunLoader */

/** @typedef {{ repository: string, issueNumber: number, expectedTaskId: string, claimant: string }} ClaimRequest */
/** @typedef {{ author: AppAuthor, controller: ControllerProvenance, leaseMs: number, now: string, source: ClaimSource }} ClaimGatewayConfig */
/** @typedef {{ number: number, state: 'open' | 'closed', type: 'issue' | 'pull-request' }} DependencyObservation */
/** @typedef {{ body: string, number: number, state: 'open' | 'closed', trustedAuthor: boolean, type: 'issue' }} GatewayIssueObservation */
/** @typedef {{ issue: GatewayIssueObservation, dependencies: DependencyObservation[], hasOpenPullRequest: boolean, comments: unknown[] }} NormalizedTaskSnapshot */
/** @typedef {{ repository: string, issueNumber: number, maxComments: number }} ReadTaskSnapshotInput */
/** @typedef {{ repository: string, issueNumber: number, body: string }} CreateCommentInput */
/** @typedef {{ repository: string, issueNumber: number, commentId: number, body: string }} UpdateCommentInput */
/** @typedef {(input: ReadTaskSnapshotInput) => unknown | Promise<unknown>} ReadTaskSnapshot */
/** @typedef {(input: CreateCommentInput) => unknown | Promise<unknown>} CreateComment */
/** @typedef {(input: UpdateCommentInput) => unknown | Promise<unknown>} UpdateComment */
/** @typedef {{ createComment: CreateComment, updateComment: UpdateComment, readTaskSnapshot: ReadTaskSnapshot, loadRun: SourceRunLoader }} GitHubClaimGateway */
/** @typedef {{ status: 'blocked', reason: string, detail?: unknown }} BlockedGatewayResult */
/** @typedef {{ status: 'ineligible', reason: string, taskId?: string }} IneligibleGatewayResult */
/** @typedef {{ status: 'existing', reason: string, commentId: number, claim: ClaimProjection }} ExistingGatewayResult */
/** @typedef {{ status: 'busy', reason: string, commentId: number, claimId: string }} BusyGatewayResult */
/** @typedef {{ status: 'acquired', reason: 'claim-created' | 'claim-replaced', commentId: number, claim: ClaimProjection }} AcquiredGatewayResult */
/** @typedef {BlockedGatewayResult | IneligibleGatewayResult | ExistingGatewayResult | BusyGatewayResult | AcquiredGatewayResult} ClaimGatewayResult */

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
 * @param {unknown} value
 * @param {string[]} expected
 * @param {string} name
 * @returns {Record<string, unknown>}
 */
function exactObject(value, expected, name) {
  const record = objectRecord(value)
  if (!record) throw new Error(`${name} must be an object`)
  const fields = Object.keys(record).sort()
  const wanted = [...expected].sort()
  if (fields.length !== wanted.length || fields.some((field, index) => field !== wanted[index])) {
    throw new Error(`${name} has missing or unknown fields`)
  }
  return record
}

/**
 * @param {unknown} value
 * @param {string} name
 * @returns {number}
 */
function positiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || /** @type {number} */ (value) < 1) {
    throw new Error(`${name} must be a positive safe integer`)
  }
  return /** @type {number} */ (value)
}

/**
 * @param {unknown} value
 * @param {ClaimRequest} request
 * @returns {NormalizedTaskSnapshot}
 */
function normalizeSnapshot(value, request) {
  const snapshot = exactObject(
    value,
    ['comments', 'commentsComplete', 'dependencies', 'issue', 'openPullRequests'],
    'Task snapshot',
  )
  const issue = exactObject(snapshot.issue, ['body', 'number', 'state', 'trustedAuthor', 'type'], 'Issue observation')
  if (issue.number !== request.issueNumber
    || issue.type !== 'issue'
    || (issue.state !== 'open' && issue.state !== 'closed')
    || typeof issue.trustedAuthor !== 'boolean'
    || (issue.body !== null && typeof issue.body !== 'string')) {
    throw new Error('Issue observation does not match the requested Issue')
  }
  if (!Array.isArray(snapshot.dependencies)) throw new Error('Dependencies must be an array')
  const dependencies = snapshot.dependencies.map(dependency => {
    const record = exactObject(dependency, ['number', 'state', 'type'], 'Dependency observation')
    if (!Number.isSafeInteger(record.number) || /** @type {number} */ (record.number) < 1
      || (record.state !== 'open' && record.state !== 'closed')
      || (record.type !== 'issue' && record.type !== 'pull-request')) {
      throw new Error('Dependency observation is invalid')
    }
    return /** @type {DependencyObservation} */ ({
      number: record.number,
      state: record.state,
      type: record.type,
    })
  })
  if (!Array.isArray(snapshot.openPullRequests)) throw new Error('Open pull requests must be an array')
  if (snapshot.commentsComplete !== true || !Array.isArray(snapshot.comments)) {
    throw new Error('Claim comment snapshot is incomplete')
  }
  if (snapshot.comments.length > MAX_RAW_COMMENTS) throw new Error('Claim comment snapshot is too large')

  /** @type {Set<number>} */
  const pullRequestNumbers = new Set()
  for (const pullRequest of snapshot.openPullRequests) {
    const record = exactObject(pullRequest, ['issueNumber', 'number', 'repository', 'state'], 'Pull request observation')
    const number = positiveInteger(record.number, 'Pull request number')
    if (record.issueNumber !== request.issueNumber
      || typeof record.repository !== 'string'
      || record.repository.toLowerCase() !== request.repository.toLowerCase()
      || record.state !== 'open') {
      throw new Error('Pull request observation does not match the current task')
    }
    pullRequestNumbers.add(number)
  }
  if (pullRequestNumbers.size > 1) throw new Error('Task has multiple open pull requests')

  return {
    issue: {
      number: request.issueNumber,
      state: issue.state,
      type: 'issue',
      trustedAuthor: issue.trustedAuthor,
      body: issue.body ?? '',
    },
    dependencies,
    hasOpenPullRequest: pullRequestNumbers.size === 1,
    comments: snapshot.comments,
  }
}

/**
 * @param {unknown} value
 * @param {number} [expectedId]
 * @returns {number}
 */
function normalizeWriteResult(value, expectedId) {
  const record = exactObject(value, ['id'], 'Claim comment write result')
  const id = positiveInteger(record.id, 'Comment id')
  if (expectedId !== undefined && id !== expectedId) throw new Error('Updated comment id changed')
  return id
}

/**
 * @param {string} reason
 * @param {unknown} [error]
 * @returns {BlockedGatewayResult}
 */
function blocked(reason, error) {
  const detail = error instanceof Error ? error.message : error
  return { status: 'blocked', reason, ...(detail ? { detail } : {}) }
}

/**
 * @param {{ request?: unknown, config?: unknown, github?: unknown }} [input]
 * @returns {Promise<ClaimGatewayResult>}
 */
export async function acquireTaskClaimThroughGateway({ request, config, github } = {}) {
  /** @type {ClaimRequest} */
  let normalizedRequest
  /** @type {ClaimGatewayConfig} */
  let normalizedConfig
  /** @type {GitHubClaimGateway} */
  let normalizedGitHub
  /** @type {ClaimCommentExpectation} */
  let expected
  try {
    const requestRecord = exactObject(request, REQUEST_FIELDS, 'Claim request')
    const configRecord = exactObject(config, CONFIG_FIELDS, 'Claim gateway configuration')
    const githubRecord = exactObject(github, GATEWAY_FIELDS, 'GitHub claim gateway')
    for (const field of GATEWAY_FIELDS) {
      if (typeof githubRecord[field] !== 'function') throw new Error(`GitHub gateway ${field} is required`)
    }

    const probe = decideClaimAcquisition({
      eligibility: { status: 'ready', taskId: requestRecord.expectedTaskId },
      selection: { status: 'claimable' },
      repository: requestRecord.repository,
      issueNumber: requestRecord.issueNumber,
      taskId: requestRecord.expectedTaskId,
      claimant: requestRecord.claimant,
      now: configRecord.now,
      leaseMs: configRecord.leaseMs,
    })
    if (probe.action !== 'create' || !probe.claim) throw new Error(probe.detail || probe.reason)
    const probeBody = renderClaimComment({
      version: 1,
      claim: probe.claim,
      controller: configRecord.controller,
      source: configRecord.source,
    })

    const authorRecord = objectRecord(configRecord.author)
    const expectedCandidate = {
      author: configRecord.author,
      repository: requestRecord.repository,
      issueNumber: requestRecord.issueNumber,
      controller: configRecord.controller,
    }
    const sourceCheck = await selectClaimCommentObservation({
      comments: [{
        id: 1,
        authorLogin: authorRecord?.login,
        authorType: authorRecord?.type,
        appSlug: authorRecord?.appSlug,
        body: probeBody,
      }],
      expected: expectedCandidate,
      loadRun: /** @type {SourceRunLoader} */ (githubRecord.loadRun),
    })
    if (sourceCheck.status !== 'authenticated') {
      const detail = 'detail' in sourceCheck ? sourceCheck.detail : undefined
      throw new Error(detail || sourceCheck.reason)
    }

    normalizedRequest = /** @type {ClaimRequest} */ (requestRecord)
    normalizedConfig = /** @type {ClaimGatewayConfig} */ (configRecord)
    normalizedGitHub = /** @type {GitHubClaimGateway} */ (githubRecord)
    expected = /** @type {ClaimCommentExpectation} */ (expectedCandidate)
  } catch (error) {
    return blocked('invalid-gateway-input', error)
  }

  /** @type {NormalizedTaskSnapshot} */
  let snapshot
  try {
    snapshot = normalizeSnapshot(await normalizedGitHub.readTaskSnapshot({
      repository: normalizedRequest.repository,
      issueNumber: normalizedRequest.issueNumber,
      maxComments: MAX_RAW_COMMENTS,
    }), normalizedRequest)
  } catch (error) {
    return blocked('snapshot-read-failed', error)
  }

  const eligibility = decideTaskEligibility({
    repository: normalizedRequest.repository,
    issue: snapshot.issue,
    trustedAuthor: snapshot.issue.trustedAuthor,
    dependencies: snapshot.dependencies,
    hasOpenPullRequest: snapshot.hasOpenPullRequest,
  })
  if (eligibility.status === 'invalid') {
    return blocked(eligibility.reason, 'detail' in eligibility ? eligibility.detail : undefined)
  }
  if (eligibility.status !== 'ready') {
    return {
      status: 'ineligible',
      reason: eligibility.reason,
      ...('taskId' in eligibility && typeof eligibility.taskId === 'string' ? { taskId: eligibility.taskId } : {}),
    }
  }
  if (eligibility.taskId !== normalizedRequest.expectedTaskId) {
    return { status: 'ineligible', reason: 'task-changed', taskId: eligibility.taskId }
  }

  const commentSelection = await selectClaimCommentObservation({
    comments: snapshot.comments,
    expected,
    loadRun: normalizedGitHub.loadRun,
  })
  if (commentSelection.status === 'invalid') {
    return blocked(commentSelection.reason, commentSelection.detail)
  }
  if (commentSelection.status === 'none' && snapshot.comments.length >= MAX_RAW_COMMENTS) {
    return blocked('claim-comment-capacity', 'Claim comment snapshot has no room for a new Claim comment')
  }

  const claimSelection = selectTaskClaim({
    repository: normalizedRequest.repository,
    issueNumber: normalizedRequest.issueNumber,
    taskId: eligibility.taskId,
    observations: commentSelection.status === 'authenticated' ? [commentSelection.observation] : [],
    now: normalizedConfig.now,
  })
  const acquisition = decideClaimAcquisition({
    eligibility,
    selection: claimSelection,
    repository: normalizedRequest.repository,
    issueNumber: normalizedRequest.issueNumber,
    taskId: eligibility.taskId,
    claimant: normalizedRequest.claimant,
    now: normalizedConfig.now,
    leaseMs: normalizedConfig.leaseMs,
  })

  if (acquisition.action === 'existing') {
    if (commentSelection.status !== 'authenticated' || !acquisition.claim) {
      return blocked('invalid-claim-selection', 'Existing Claim is missing its authenticated comment projection')
    }
    return {
      status: 'existing',
      reason: acquisition.reason,
      commentId: commentSelection.commentId,
      claim: acquisition.claim,
    }
  }
  if (acquisition.action === 'busy') {
    if (commentSelection.status !== 'authenticated' || typeof acquisition.claimId !== 'string') {
      return blocked('invalid-claim-selection', 'Busy Claim is missing its authenticated comment projection')
    }
    return {
      status: 'busy',
      reason: acquisition.reason,
      commentId: commentSelection.commentId,
      claimId: acquisition.claimId,
    }
  }
  if (acquisition.action !== 'create') {
    return acquisition.action === 'ineligible'
      ? { status: 'ineligible', reason: acquisition.reason }
      : blocked(acquisition.reason, acquisition.detail)
  }
  if (!acquisition.claim) return blocked('invalid-claim-selection', 'Created Claim projection is missing')

  /** @type {string} */
  let body
  /** @type {ClaimCommentRecord} */
  let intendedRecord
  try {
    body = renderClaimComment({
      version: 1,
      claim: acquisition.claim,
      controller: normalizedConfig.controller,
      source: normalizedConfig.source,
    })
    const parsedRecord = parseClaimComment(body)
    if (!parsedRecord) throw new Error('Rendered comment has no Claim marker')
    intendedRecord = parsedRecord
  } catch (error) {
    return blocked('claim-render-failed', error)
  }

  /** @type {number} */
  let commentId
  try {
    commentId = commentSelection.status === 'authenticated'
      ? normalizeWriteResult(await normalizedGitHub.updateComment({
          repository: normalizedRequest.repository,
          issueNumber: normalizedRequest.issueNumber,
          commentId: commentSelection.commentId,
          body,
        }), commentSelection.commentId)
      : normalizeWriteResult(await normalizedGitHub.createComment({
          repository: normalizedRequest.repository,
          issueNumber: normalizedRequest.issueNumber,
          body,
        }))
  } catch (error) {
    return blocked('claim-write-failed', error)
  }

  try {
    const postWriteSnapshot = normalizeSnapshot(await normalizedGitHub.readTaskSnapshot({
      repository: normalizedRequest.repository,
      issueNumber: normalizedRequest.issueNumber,
      maxComments: MAX_RAW_COMMENTS,
    }), normalizedRequest)
    const postWriteEligibility = decideTaskEligibility({
      repository: normalizedRequest.repository,
      issue: postWriteSnapshot.issue,
      trustedAuthor: postWriteSnapshot.issue.trustedAuthor,
      dependencies: postWriteSnapshot.dependencies,
      hasOpenPullRequest: postWriteSnapshot.hasOpenPullRequest,
    })
    if (postWriteEligibility.status !== 'ready'
      || postWriteEligibility.taskId !== normalizedRequest.expectedTaskId) {
      throw new Error('Task changed while the Claim comment was being written')
    }

    const written = postWriteSnapshot.comments.find(comment => objectRecord(comment)?.id === commentId)
    const verified = await selectClaimCommentObservation({
      comments: postWriteSnapshot.comments,
      expected,
      loadRun: normalizedGitHub.loadRun,
    })
    if (verified.status !== 'authenticated'
      || verified.commentId !== commentId
      || objectRecord(written)?.body !== body
      || JSON.stringify(verified.record) !== JSON.stringify(intendedRecord)) {
      throw new Error('Written Claim comment does not match the intended projection')
    }
  } catch (error) {
    return blocked('claim-reread-mismatch', error)
  }

  return {
    status: 'acquired',
    reason: commentSelection.status === 'authenticated' ? 'claim-replaced' : 'claim-created',
    commentId,
    claim: acquisition.claim,
  }
}
