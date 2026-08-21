import { parseWorkerRouteDecisionBody } from './worker-routing.mjs'

const STATUS_PATTERN = /^- Status: \*\*(running|capacity-waiting|complete|failed|dead-letter)\*\*$/m
const RUN_ID_PATTERN = /^- Run: https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/actions\/runs\/(\d+)\s*$/m
const MARKER_PATTERN = /^<!-- dsh-review-repair:([0-9a-f]{40}):([0-9a-f]{40})(?::[A-Za-z0-9._-]{1,100})? -->$/m
const CONTROLLER_SHA_PATTERN = /^- Controller SHA: `([0-9a-f]{40})`$/m
const REPAIR_CLASS_PATTERN = /^- Repair class: `(automatic-review|automatic-ci|explicit-human)`$/m
const ROUTE_DECISION_MARKER = '<!-- worker-route-decision:v1 -->'
const ROUTE_DECISION_TRAILER = '<!-- /worker-route-decision:v1 -->'

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

/** Parse the existing durable WorkerRouteDecision carried by one repair status comment. */
export function recordedRepairRouteDecision(body, options = {}) {
  const text = String(body || '')
  const markerAt = text.indexOf(ROUTE_DECISION_MARKER)
  if (markerAt < 0) return null
  const trailerAt = text.indexOf(ROUTE_DECISION_TRAILER, markerAt)
  if (markerAt !== text.lastIndexOf(ROUTE_DECISION_MARKER)
    || trailerAt < 0
    || trailerAt !== text.lastIndexOf(ROUTE_DECISION_TRAILER)) {
    throw new Error('Repair status must contain one durable WorkerRouteDecision')
  }
  return parseWorkerRouteDecisionBody(
    text.slice(markerAt, trailerAt + ROUTE_DECISION_TRAILER.length),
    options,
  )
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
