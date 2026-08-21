const STATUS_PATTERN = /^- Status: \*\*(running|capacity-waiting|complete|failed|dead-letter)\*\*$/m
const RUN_ID_PATTERN = /^- Run: https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/actions\/runs\/(\d+)\s*$/m
const RUN_REPOSITORY_PATTERN = /^- Run: https:\/\/github\.com\/([^/\s]+\/[^/\s]+)\/actions\/runs\/(\d+)\s*$/m
const MARKER_PATTERN = /^<!-- dsh-review-repair:([0-9a-f]{40}):([0-9a-f]{40})(?::([A-Za-z0-9._-]{1,100}))? -->$/m
const CONTROLLER_SHA_PATTERN = /^- Controller SHA: `([0-9a-f]{40})`$/m
const REPAIR_CLASS_PATTERN = /^- Repair class: `(automatic-review|automatic-ci|explicit-human)`$/m
const REVIEWED_HEAD_PATTERN = /^- Reviewed head: `([0-9a-f]{40})`$/m
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{1,100}$/

function recoverySourceRunId(requestId) {
  const ci = /^ci-run-[1-9][0-9]{0,19}-[1-9][0-9]{0,19}\.recovery-[1-9][0-9]{0,19}$/.exec(requestId)
  if (ci) return { sourceRunId: null, originalRequestId: requestId.replace(/\.recovery-[1-9][0-9]{0,19}$/, '') }
  const ordinary = /^recovery-([1-9][0-9]{0,19})-[1-9][0-9]{0,19}$/.exec(requestId)
  return ordinary ? { sourceRunId: ordinary[1], originalRequestId: null } : null
}

function sourceRepairComment(comment, { controllerSha, expectedHead, sourceRunId, markerAuthor, repository } = {}) {
  if (typeof markerAuthor !== 'string' || comment?.user?.login !== markerAuthor) return null
  const text = String(comment?.body || '')
  const marker = text.match(MARKER_PATTERN)
  const recordedControllerSha = text.match(CONTROLLER_SHA_PATTERN)?.[1]
  const state = recordedRepairState(text)
  const run = text.match(RUN_REPOSITORY_PATTERN)
  const reviewedHead = text.match(REVIEWED_HEAD_PATTERN)?.[1]
  if (!marker || marker[1] !== controllerSha || recordedControllerSha !== controllerSha || marker[2] !== expectedHead
    || !marker[3] || !REQUEST_ID_PATTERN.test(marker[3])
    || /^recovery-/.test(marker[3]) || /\.recovery-[1-9][0-9]*$/.test(marker[3])
    || !state.status || state.runId !== sourceRunId || run?.[1] !== repository || run?.[2] !== sourceRunId
    || reviewedHead !== expectedHead) return null
  return { requestId: marker[3], runId: state.runId, status: state.status }
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
  const repairClass = text.match(REPAIR_CLASS_PATTERN)?.[1] || null
  return { marker, controllerSha, repairClass, ...recordedRepairState(text) }
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
  if (!recovery) return { requestId, originalRequestId: requestId, sourceRunId: null, sourceStatus: null }
  const sourceRunIds = recovery.sourceRunId
    ? [recovery.sourceRunId]
    : [...new Set((Array.isArray(comments) ? comments : []).map(comment => {
      const text = String(comment?.body || '')
      const run = text.match(RUN_REPOSITORY_PATTERN)
      return run?.[1] === repository ? run[2] : null
    }).filter(Boolean))]
  const candidates = sourceRunIds.flatMap(sourceRunId => (Array.isArray(comments) ? comments : [])
    .map(comment => sourceRepairComment(comment, {
      controllerSha, expectedHead, sourceRunId, markerAuthor, repository,
    }))
    .filter(value => value && (!recovery.originalRequestId || value.requestId === recovery.originalRequestId)))
  if (candidates.length !== 1) throw new Error(`Recovery request ${requestId} has no unique trusted repair source comment`)
  return {
    requestId,
    originalRequestId: candidates[0].requestId,
    sourceRunId: candidates[0].runId,
    sourceStatus: candidates[0].status,
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
