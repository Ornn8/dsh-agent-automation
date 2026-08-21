const STATUS_PATTERN = /^- Status: \*\*(running|capacity-waiting|complete|failed|dead-letter)\*\*$/m
const RUN_ID_PATTERN = /^- Run: https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/actions\/runs\/(\d+)\s*$/m
const RUN_REPOSITORY_PATTERN = /^- Run: https:\/\/github\.com\/([^/\s]+\/[^/\s]+)\/actions\/runs\/(\d+)\s*$/m
const MARKER_PATTERN = /^<!-- dsh-review-repair:([0-9a-f]{40}):([0-9a-f]{40})(?::([A-Za-z0-9._-]{1,100}))? -->$/m
const CONTROLLER_SHA_PATTERN = /^- Controller SHA: `([0-9a-f]{40})`$/m
const REPAIR_CLASS_PATTERN = /^- Repair class: `(automatic-review|automatic-merge|automatic-ci|explicit-human)`$/m
const REPAIR_CLASS_LINE_PATTERN = /^- Repair class: .*$/gm
const STAGE_LINE_PATTERN = /^- Stage: .*$/gm
const STAGE_VALUE_PATTERN = /^- Stage: `([A-Za-z0-9][A-Za-z0-9._-]{0,63})`$/
const CI_WORKFLOW_LINE_PATTERN = /^- CI workflow: .*$/gm
const CI_WORKFLOW_VALUE_PATTERN = /^- CI workflow: `([^`\r\n]{1,100})`$/
const ORIGINAL_REQUEST_LINE_PATTERN = /^- Original request: .*$/gm
const ORIGINAL_REQUEST_VALUE_PATTERN = /^- Original request: `([A-Za-z0-9._-]{1,100})`$/
const REVIEWED_HEAD_PATTERN = /^- Reviewed head: `([0-9a-f]{40})`$/m
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{1,100}$/

function recoverySourceRunId(requestId) {
  const ci = /^ci-run-[1-9][0-9]{0,19}-[1-9][0-9]{0,19}\.recovery-[1-9][0-9]{0,19}$/.exec(requestId)
  if (ci) return { sourceRunId: null, originalRequestId: requestId.replace(/\.recovery-[1-9][0-9]{0,19}$/, '') }
  const ordinary = /^recovery-([1-9][0-9]{0,19})-[1-9][0-9]{0,19}$/.exec(requestId)
  return ordinary ? { sourceRunId: ordinary[1], originalRequestId: null } : null
}

function strictOptionalLine(text, linePattern, valuePattern) {
  const lines = [...text.matchAll(linePattern)]
  if (lines.length === 0) return null
  if (lines.length !== 1) return undefined
  return valuePattern.exec(lines[0][0])?.[1] || undefined
}

function repairRoutingFromStatus(status) {
  if (!status?.repairClass || status.workflowStage === undefined || status.ciWorkflow === undefined) return null
  if (status.repairClass === 'automatic-ci') {
    if (!status.ciWorkflow) return null
    return {
      repairClass: status.repairClass,
      repairCause: status.ciWorkflow,
      repairCode: status.ciWorkflow,
      workflowStage: status.workflowStage || 'repair',
      ciWorkflow: status.ciWorkflow,
    }
  }
  if (status.ciWorkflow !== null) return null
  const repairCause = status.repairClass === 'automatic-merge' ? 'merge-conflict' : 'review-repair'
  return {
    repairClass: status.repairClass,
    repairCause,
    repairCode: repairCause,
    workflowStage: status.workflowStage || 'repair',
    ciWorkflow: null,
  }
}

/**
 * Validate one controller-authored repair status comment and restore its root request evidence.
 * @param {unknown} comment
 * @param {{controllerSha?: string, expectedHead?: string, sourceRunId?: string, markerAuthor?: string, repository?: string}} options
 * @returns {{requestId: string, markerRequestId: string, runId: string, status: string, repairClass: string, repairCause: string, repairCode: string, workflowStage: string, ciWorkflow: string|null}|null}
 */
export function trustedRepairSourceComment(comment, { controllerSha, expectedHead, sourceRunId, markerAuthor, repository } = {}) {
  if (typeof markerAuthor !== 'string' || comment?.user?.login !== markerAuthor) return null
  const text = String(comment?.body || '')
  const marker = text.match(MARKER_PATTERN)
  const recordedControllerSha = text.match(CONTROLLER_SHA_PATTERN)?.[1]
  const status = recordedRepairStatus(text)
  const run = text.match(RUN_REPOSITORY_PATTERN)
  const reviewedHead = text.match(REVIEWED_HEAD_PATTERN)?.[1]
  const routing = repairRoutingFromStatus(status)
  const markerIsRecovery = /^recovery-/.test(marker?.[3] || '') || /\.recovery-[1-9][0-9]*$/.test(marker?.[3] || '')
  const originalRequestId = status.originalRequestId === null ? marker?.[3] : status.originalRequestId
  const originalIsRecovery = recoverySourceRunId(originalRequestId || '') !== null
  if (!marker || marker[1] !== controllerSha || recordedControllerSha !== controllerSha || marker[2] !== expectedHead
    || !marker[3] || !REQUEST_ID_PATTERN.test(marker[3])
    || (markerIsRecovery !== (status.originalRequestId !== null))
    || !originalRequestId || !REQUEST_ID_PATTERN.test(originalRequestId) || originalIsRecovery
    || !status.status || status.runId !== sourceRunId || run?.[1] !== repository || run?.[2] !== sourceRunId
    || reviewedHead !== expectedHead || !routing) return null
  return {
    requestId: originalRequestId,
    markerRequestId: marker[3],
    runId: status.runId,
    status: status.status,
    ...routing,
  }
}

/**
 * Recover the root WorkRequest id from one strictly verified repair status comment.
 * @param {{comment?: unknown, controllerSha?: string, expectedHead?: string, sourceRunId?: string, markerAuthor?: string, repository?: string}} options
 * @returns {string|null}
 */
export function trustedRepairRecoveryRequestId({ comment, ...sourceOptions } = {}) {
  return trustedRepairSourceComment(comment, sourceOptions)?.requestId || null
}

/** Parse the durable state recorded by one repair status comment. */
export function recordedRepairState(body) {
  const text = String(body || '')
  return {
    status: text.match(STATUS_PATTERN)?.[1] || null,
    runId: text.match(RUN_ID_PATTERN)?.[1] || null,
  }
}

/** Parse the controller provenance and class carried by one repair status comment. */
export function recordedRepairStatus(body) {
  const text = String(body || '')
  const marker = text.match(MARKER_PATTERN)?.[0] || null
  const controllerSha = text.match(CONTROLLER_SHA_PATTERN)?.[1] || null
  const repairClass = strictOptionalLine(text, REPAIR_CLASS_LINE_PATTERN, REPAIR_CLASS_PATTERN)
  return {
    marker,
    controllerSha,
    repairClass,
    workflowStage: strictOptionalLine(text, STAGE_LINE_PATTERN, STAGE_VALUE_PATTERN),
    ciWorkflow: strictOptionalLine(text, CI_WORKFLOW_LINE_PATTERN, CI_WORKFLOW_VALUE_PATTERN),
    originalRequestId: strictOptionalLine(text, ORIGINAL_REQUEST_LINE_PATTERN, ORIGINAL_REQUEST_VALUE_PATTERN),
    ...recordedRepairState(text),
  }
}

/** Restore a recovery dispatch to exactly one controller-authored source repair request. */
export function recoverableRepairIdentity({ requestId, comments, controllerSha, expectedHead, markerAuthor, repository } = {}) {
  if (typeof requestId !== 'string' || !REQUEST_ID_PATTERN.test(requestId)) {
    throw new Error('Recovery request id is invalid')
  }
  if (typeof repository !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new Error('Recovery source repository is invalid')
  }
  const recovery = recoverySourceRunId(requestId)
  if (!recovery) {
    return {
      requestId,
      originalRequestId: requestId,
      sourceRunId: null,
      sourceStatus: null,
      repairClass: null,
      repairCause: null,
      repairCode: null,
      workflowStage: null,
      ciWorkflow: null,
    }
  }
  const sourceRunIds = recovery.sourceRunId
    ? [recovery.sourceRunId]
    : [...new Set((Array.isArray(comments) ? comments : []).map(comment => {
      const text = String(comment?.body || '')
      const run = text.match(RUN_REPOSITORY_PATTERN)
      return run?.[1] === repository ? run[2] : null
    }).filter(Boolean))]
  const candidates = sourceRunIds.flatMap(sourceRunId => (Array.isArray(comments) ? comments : [])
    .map(comment => trustedRepairSourceComment(comment, {
      controllerSha, expectedHead, sourceRunId, markerAuthor, repository,
    }))
    .filter(value => value && (!recovery.originalRequestId || value.markerRequestId === recovery.originalRequestId)))
  if (candidates.length !== 1) throw new Error(`Recovery request ${requestId} has no unique trusted repair source comment`)
  return {
    requestId,
    originalRequestId: candidates[0].requestId,
    sourceRunId: candidates[0].runId,
    sourceStatus: candidates[0].status,
    repairClass: candidates[0].repairClass,
    repairCause: candidates[0].repairCause,
    repairCode: candidates[0].repairCode,
    workflowStage: candidates[0].workflowStage,
    ciWorkflow: candidates[0].ciWorkflow,
  }
}

/**
 * Keep repair routing evidence limited to exact changed paths, trusted Stage, and verified cause.
 * @param {{paths?: unknown, workflowStage?: unknown, failureEvidence?: unknown}} options
 * @returns {{paths: unknown[], workflowStage: string, failureEvidence: object}}
 */
export function repairRoutingEvidence({ paths, workflowStage, failureEvidence } = {}) {
  return {
    paths: Array.isArray(paths) ? paths : [],
    workflowStage: typeof workflowStage === 'string' ? workflowStage : '',
    failureEvidence: failureEvidence && typeof failureEvidence === 'object' && !Array.isArray(failureEvidence)
      ? failureEvidence
      : {},
  }
}

/** Return whether a replacement run may reclaim an interrupted repair request. */
export function interruptedRepairMayRetry(body, actionRun) {
  const recorded = recordedRepairState(body)
  if (recorded.status === 'capacity-waiting') {
    return recorded.runId === String(actionRun?.id || '')
      && actionRun?.status === 'completed'
      && actionRun.conclusion === 'success'
  }
  return recorded.status === 'running'
    && recorded.runId === String(actionRun?.id || '')
    && actionRun?.status === 'completed'
    && Boolean(actionRun.conclusion)
    && actionRun.conclusion !== 'success'
}
