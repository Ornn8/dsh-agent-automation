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

function exactObject(value, expected, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${name} must be an object`)
  }
  const fields = Object.keys(value).sort()
  const wanted = [...expected].sort()
  if (fields.length !== wanted.length || fields.some((field, index) => field !== wanted[index])) {
    throw new Error(`${name} has missing or unknown fields`)
  }
}

function positiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive safe integer`)
  }
  return value
}

function normalizeSnapshot(value, request) {
  exactObject(
    value,
    ['comments', 'commentsComplete', 'dependencies', 'issue', 'openPullRequests'],
    'Task snapshot',
  )
  exactObject(value.issue, ['body', 'number', 'state', 'trustedAuthor', 'type'], 'Issue observation')
  if (value.issue.number !== request.issueNumber
    || value.issue.type !== 'issue'
    || !['open', 'closed'].includes(value.issue.state)
    || typeof value.issue.trustedAuthor !== 'boolean'
    || (value.issue.body !== null && typeof value.issue.body !== 'string')) {
    throw new Error('Issue observation does not match the requested Issue')
  }
  if (!Array.isArray(value.dependencies)) throw new Error('Dependencies must be an array')
  const dependencies = value.dependencies.map(dependency => {
    exactObject(dependency, ['number', 'state', 'type'], 'Dependency observation')
    if (!Number.isSafeInteger(dependency.number) || dependency.number < 1
      || !['open', 'closed'].includes(dependency.state)
      || !['issue', 'pull-request'].includes(dependency.type)) {
      throw new Error('Dependency observation is invalid')
    }
    return dependency
  })
  if (!Array.isArray(value.openPullRequests)) throw new Error('Open pull requests must be an array')
  if (value.commentsComplete !== true || !Array.isArray(value.comments)) {
    throw new Error('Claim comment snapshot is incomplete')
  }
  if (value.comments.length > MAX_RAW_COMMENTS) throw new Error('Claim comment snapshot is too large')

  const pullRequestNumbers = new Set()
  for (const pullRequest of value.openPullRequests) {
    exactObject(pullRequest, ['issueNumber', 'number', 'repository', 'state'], 'Pull request observation')
    const number = positiveInteger(pullRequest.number, 'Pull request number')
    if (pullRequest.issueNumber !== request.issueNumber
      || typeof pullRequest.repository !== 'string'
      || pullRequest.repository.toLowerCase() !== request.repository.toLowerCase()
      || pullRequest.state !== 'open') {
      throw new Error('Pull request observation does not match the current task')
    }
    pullRequestNumbers.add(number)
  }
  if (pullRequestNumbers.size > 1) throw new Error('Task has multiple open pull requests')

  return {
    issue: { ...value.issue, body: value.issue.body ?? '' },
    dependencies,
    hasOpenPullRequest: pullRequestNumbers.size === 1,
    comments: value.comments,
  }
}

function normalizeWriteResult(value, expectedId) {
  exactObject(value, ['id'], 'Claim comment write result')
  const id = positiveInteger(value.id, 'Comment id')
  if (expectedId !== undefined && id !== expectedId) throw new Error('Updated comment id changed')
  return id
}

function blocked(reason, error) {
  const detail = error instanceof Error ? error.message : error
  return { status: 'blocked', reason, ...(detail ? { detail } : {}) }
}

export async function acquireTaskClaimThroughGateway({ request, config, github } = {}) {
  let expected
  try {
    exactObject(request, REQUEST_FIELDS, 'Claim request')
    exactObject(config, CONFIG_FIELDS, 'Claim gateway configuration')
    exactObject(github, GATEWAY_FIELDS, 'GitHub claim gateway')
    for (const field of GATEWAY_FIELDS) {
      if (typeof github[field] !== 'function') throw new Error(`GitHub gateway ${field} is required`)
    }

    const probe = decideClaimAcquisition({
      eligibility: { status: 'ready', taskId: request.expectedTaskId },
      selection: { status: 'claimable' },
      repository: request.repository,
      issueNumber: request.issueNumber,
      taskId: request.expectedTaskId,
      claimant: request.claimant,
      now: config.now,
      leaseMs: config.leaseMs,
    })
    if (probe.action !== 'create') throw new Error(probe.detail || probe.reason)
    const probeBody = renderClaimComment({
      version: 1,
      claim: probe.claim,
      controller: config.controller,
      source: config.source,
    })

    expected = {
      author: config.author,
      repository: request.repository,
      issueNumber: request.issueNumber,
      controller: config.controller,
    }
    const sourceCheck = await selectClaimCommentObservation({
      comments: [{
        id: 1,
        authorLogin: config.author?.login,
        authorType: config.author?.type,
        appSlug: config.author?.appSlug,
        body: probeBody,
      }],
      expected,
      loadRun: github.loadRun,
    })
    if (sourceCheck.status !== 'authenticated') {
      throw new Error(sourceCheck.detail || sourceCheck.reason)
    }
  } catch (error) {
    return blocked('invalid-gateway-input', error)
  }

  let snapshot
  try {
    snapshot = normalizeSnapshot(await github.readTaskSnapshot({
      repository: request.repository,
      issueNumber: request.issueNumber,
      maxComments: MAX_RAW_COMMENTS,
    }), request)
  } catch (error) {
    return blocked('snapshot-read-failed', error)
  }

  const eligibility = decideTaskEligibility({
    repository: request.repository,
    issue: snapshot.issue,
    trustedAuthor: snapshot.issue.trustedAuthor,
    dependencies: snapshot.dependencies,
    hasOpenPullRequest: snapshot.hasOpenPullRequest,
  })
  if (eligibility.status === 'invalid') {
    return blocked(eligibility.reason, eligibility.detail)
  }
  if (eligibility.status !== 'ready') {
    return {
      status: 'ineligible',
      reason: eligibility.reason,
      ...(eligibility.taskId ? { taskId: eligibility.taskId } : {}),
    }
  }
  if (eligibility.taskId !== request.expectedTaskId) {
    return { status: 'ineligible', reason: 'task-changed', taskId: eligibility.taskId }
  }

  const commentSelection = await selectClaimCommentObservation({
    comments: snapshot.comments,
    expected,
    loadRun: github.loadRun,
  })
  if (commentSelection.status === 'invalid') {
    return blocked(commentSelection.reason, commentSelection.detail)
  }

  const claimSelection = selectTaskClaim({
    repository: request.repository,
    issueNumber: request.issueNumber,
    taskId: eligibility.taskId,
    observations: commentSelection.status === 'authenticated' ? [commentSelection.observation] : [],
    now: config.now,
  })
  const acquisition = decideClaimAcquisition({
    eligibility,
    selection: claimSelection,
    repository: request.repository,
    issueNumber: request.issueNumber,
    taskId: eligibility.taskId,
    claimant: request.claimant,
    now: config.now,
    leaseMs: config.leaseMs,
  })

  if (acquisition.action === 'existing') {
    return {
      status: 'existing',
      reason: acquisition.reason,
      commentId: commentSelection.commentId,
      claim: acquisition.claim,
    }
  }
  if (acquisition.action === 'busy') {
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

  let body
  let intendedRecord
  try {
    body = renderClaimComment({
      version: 1,
      claim: acquisition.claim,
      controller: config.controller,
      source: config.source,
    })
    intendedRecord = parseClaimComment(body)
    if (!intendedRecord) throw new Error('Rendered comment has no Claim marker')
  } catch (error) {
    return blocked('claim-render-failed', error)
  }

  let commentId
  try {
    commentId = commentSelection.status === 'authenticated'
      ? normalizeWriteResult(await github.updateComment({
          repository: request.repository,
          issueNumber: request.issueNumber,
          commentId: commentSelection.commentId,
          body,
        }), commentSelection.commentId)
      : normalizeWriteResult(await github.createComment({
          repository: request.repository,
          issueNumber: request.issueNumber,
          body,
        }))
  } catch (error) {
    return blocked('claim-write-failed', error)
  }

  try {
    const postWriteSnapshot = normalizeSnapshot(await github.readTaskSnapshot({
      repository: request.repository,
      issueNumber: request.issueNumber,
      maxComments: MAX_RAW_COMMENTS,
    }), request)
    const postWriteEligibility = decideTaskEligibility({
      repository: request.repository,
      issue: postWriteSnapshot.issue,
      trustedAuthor: postWriteSnapshot.issue.trustedAuthor,
      dependencies: postWriteSnapshot.dependencies,
      hasOpenPullRequest: postWriteSnapshot.hasOpenPullRequest,
    })
    if (postWriteEligibility.status !== 'ready'
      || postWriteEligibility.taskId !== request.expectedTaskId) {
      throw new Error('Task changed while the Claim comment was being written')
    }

    const written = postWriteSnapshot.comments.find(comment => comment?.id === commentId)
    const verified = await selectClaimCommentObservation({
      comments: postWriteSnapshot.comments,
      expected,
      loadRun: github.loadRun,
    })
    if (verified.status !== 'authenticated'
      || verified.commentId !== commentId
      || written?.body !== body
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
