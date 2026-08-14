const STATUS_PATTERN = /^- Status: \*\*(running|complete|failed)\*\*$/m
const RUN_ID_PATTERN = /^- Run: https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/actions\/runs\/(\d+)\s*$/m

/** Parse the durable state recorded by one repair status comment. */
export function recordedRepairState(body) {
  const text = String(body || '')
  return {
    status: text.match(STATUS_PATTERN)?.[1] || null,
    runId: text.match(RUN_ID_PATTERN)?.[1] || null,
  }
}

/** Return whether a replacement run may reclaim an interrupted repair request. */
export function interruptedRepairMayRetry(body, actionRun) {
  const recorded = recordedRepairState(body)
  return recorded.status === 'running'
    && recorded.runId === String(actionRun?.id || '')
    && actionRun?.status === 'completed'
    && Boolean(actionRun.conclusion)
    && actionRun.conclusion !== 'success'
}
