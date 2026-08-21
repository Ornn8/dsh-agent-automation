const STATUS_PATTERN = /^- Status: \*\*(running|capacity-waiting|complete|failed|dead-letter)\*\*$/m
const RUN_ID_PATTERN = /^- Run: https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/actions\/runs\/(\d+)\s*$/m
const MARKER_PATTERN = /^<!-- dsh-review-repair:([0-9a-f]{40}):([0-9a-f]{40})(?::[A-Za-z0-9._-]{1,100})? -->$/m
const CONTROLLER_SHA_PATTERN = /^- Controller SHA: `([0-9a-f]{40})`$/m
const REPAIR_CLASS_PATTERN = /^- Repair class: `(automatic-review|automatic-ci|explicit-human)`$/m
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
