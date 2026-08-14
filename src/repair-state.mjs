export const MAX_AUTOMATIC_REPAIR_ATTEMPTS = 6

const STATUS_PATTERN = /^- Status: \*\*(running|complete|failed|dead-letter)\*\*$/m
const RUN_ID_PATTERN = /^- Run: https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/actions\/runs\/(\d+)\s*$/m
const MARKER_PATTERN = /^<!-- dsh-review-repair:([0-9a-f]{40}):([0-9a-f]{40})(?::[A-Za-z0-9._-]{1,100})? -->$/m
const CONTROLLER_SHA_PATTERN = /^- Controller SHA: `([0-9a-f]{40})`$/m
const REPAIR_CLASS_PATTERN = /^- Repair class: `(automatic-review|automatic-ci|explicit-human)`$/m
const AUTOMATIC_REPAIR_CLASSES = new Set(['automatic-review', 'automatic-ci'])

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

/** Count distinct automatic repair requests created by one controller for one pull request. */
export function automaticRepairAttemptCount(comments, { authorLogin, controllerSha }) {
  if (typeof authorLogin !== 'string' || !authorLogin.trim()) {
    throw new Error('Automatic repair counting requires the controller GitHub login')
  }
  const normalizedSha = String(controllerSha || '').toLowerCase()
  if (!/^[0-9a-f]{40}$/.test(normalizedSha)) {
    throw new Error('Automatic repair counting requires a full lowercase controller SHA')
  }
  const markers = new Set()
  for (const comment of comments) {
    if (comment?.user?.login !== authorLogin) continue
    const recorded = recordedRepairStatus(comment.body)
    const markerControllerSha = /^<!-- dsh-review-repair:([0-9a-f]{40}):/.exec(recorded.marker || '')?.[1]
    if (recorded.status === 'dead-letter'
      || recorded.controllerSha !== normalizedSha
      || markerControllerSha !== normalizedSha
      || !AUTOMATIC_REPAIR_CLASSES.has(recorded.repairClass)
      || !recorded.marker) continue
    markers.add(recorded.marker)
  }
  return markers.size
}

/** Return whether the bounded automatic repair budget has been consumed. */
export function automaticRepairLimitReached(attempts) {
  if (!Number.isSafeInteger(attempts) || attempts < 0) {
    throw new Error('Automatic repair attempts must be a non-negative integer')
  }
  return attempts >= MAX_AUTOMATIC_REPAIR_ATTEMPTS
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
