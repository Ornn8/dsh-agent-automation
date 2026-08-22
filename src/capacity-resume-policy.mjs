// @ts-check

import { projectWorkerCapacityIdentity } from './capacity-registry.mjs'
import { capacityResumeRequestId, parseCapacityWaitProjection } from './capacity-wait-projection.mjs'
import { resolveWorkerCandidates } from './machine-config.mjs'
import { parseWorkerCapacityInspection } from './capacity-registry-store.mjs'
import { parseAgentWorkRequest, repositoryDispatchBody } from './work-request.mjs'
import { parseWorkerRouteDecision } from './worker-routing.mjs'
import { parseWorkflowDefinition, workflowDefinitionHash } from './workflow-definition.mjs'
import { resolveWorkflowStage } from './workflow-profile.mjs'

const SHA256 = /^[a-f0-9]{64}$/
const SHA1 = /^[a-f0-9]{40}$/
const DECISIONS = new Set(['stale', 'deferred', 'resume'])

/** @typedef {Record<string, any>} AnyObject */
/** @typedef {{version: number, workRequestId: string, repository: string, role: string, profileId: string, workflowId: string, stageId: string, definitionHash: string, revision: {base: string, head: string}, coordinationKey: string, subject: {type: string, number: number, stateVersion: string}, routeDecision: AnyObject, capacityGenerationHash: string, observationId: string}} Projection */

/** @param {unknown} value @returns {string} */
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    const object = /** @type {Record<string, unknown>} */ (value)
    return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

/** @param {string} identity @param {string} reason @param {string[]} currentCandidates @param {string[]} availableCandidates @param {string|null} generationHash @returns {AnyObject} */
function decision(identity, reason, currentCandidates = [], availableCandidates = [], generationHash = null) {
  const selected = availableCandidates.length > 0 ? 'resume' : 'deferred'
  const result = {
    version: 1,
    decision: reason === 'capacity-available' || reason === 'capacity-unavailable' ? selected : 'stale',
    reason,
    capacityResumeRequestId: identity,
    currentCandidates: [...currentCandidates],
    availableCandidates: [...availableCandidates],
    capacityGenerationHash: generationHash,
  }
  if (!DECISIONS.has(result.decision)) throw new Error('capacity resume decision is invalid')
  return result
}

/** @param {unknown} value @returns {AnyObject|null} */
function objectOrNull(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? /** @type {AnyObject} */ (value)
    : null
}

/** @param {AnyObject|null} value @returns {boolean} */
function validSubject(value) {
  return Boolean(value
    && value.type === 'issue'
    && Number.isSafeInteger(value.number) && value.number > 0
    && SHA256.test(value.stateVersion || '')
    && objectOrNull(value.revision)
    && SHA1.test(value.revision.base || '')
    && SHA1.test(value.revision.head || ''))
}

/** @param {unknown} value @returns {boolean} */
function validNow(value) {
  return Number.isSafeInteger(value) && /** @type {number} */ (value) >= 0
}

/**
 * Evaluate whether a persisted Issue capacity wait is still bound to current trusted state.
 * The evaluator is pure: callers provide the current WorkRequest, Profile, Issue state,
 * route decision, machine configuration, capacity inspection plans, and observation time.
 * @param {{projection?: unknown, workRequest?: unknown, profile?: unknown, currentSubject?: unknown, currentRouteDecision?: unknown, machineConfig?: unknown, capacitySnapshot?: unknown, now?: unknown}} input
 * @returns {AnyObject}
 */
export function evaluateCapacityWaitResume({
  projection, workRequest, profile, currentSubject, currentRouteDecision, machineConfig, capacitySnapshot, now,
} = {}) {
  const parsedProjection = /** @type {Projection} */ (parseCapacityWaitProjection(projection))
  const identity = capacityResumeRequestId(parsedProjection)
  /** @type {(reason: string, candidates?: string[], available?: string[], hash?: string|null) => AnyObject} */
  const stale = (reason, candidates = [], available = [], hash = null) => decision(identity, reason, candidates, available, hash)

  let request
  try {
    request = parseAgentWorkRequest(workRequest)
  } catch {
    return stale('work-request-invalid')
  }
  if (request.role !== 'change' || request.subject.type !== 'issue'
    || request.requestId !== parsedProjection.workRequestId
    || request.repository !== parsedProjection.repository
    || request.profileId !== parsedProjection.profileId
    || request.workflowId !== parsedProjection.workflowId
    || request.stageId !== parsedProjection.stageId
    || request.definitionHash !== parsedProjection.definitionHash
    || request.role !== parsedProjection.role
    || canonicalJson(request.revision) !== canonicalJson(parsedProjection.revision)
    || canonicalJson(request.subject) !== canonicalJson({ type: parsedProjection.subject.type, number: parsedProjection.subject.number })
    || request.coordinationKey !== parsedProjection.coordinationKey) {
    return stale('work-request-mismatch')
  }

  const subject = objectOrNull(currentSubject)
  if (!validSubject(subject)) return stale('subject-state-invalid')
  const current = /** @type {AnyObject} */ (subject)
  if (current.type !== parsedProjection.subject.type || current.number !== parsedProjection.subject.number
    || current.stateVersion !== parsedProjection.subject.stateVersion
    || canonicalJson(current.revision) !== canonicalJson(parsedProjection.revision)) {
    return stale('subject-or-revision-stale')
  }

  const suppliedProfile = objectOrNull(profile)
  let definition
  try {
    definition = parseWorkflowDefinition(suppliedProfile?.definition)
  } catch {
    return stale('profile-invalid')
  }
  const definitionHash = workflowDefinitionHash(definition)
  if (definition.profileId !== request.profileId
    || suppliedProfile?.definitionHash !== definitionHash
    || definitionHash !== request.definitionHash) {
    return stale('profile-mismatch')
  }
  try {
    const stage = resolveWorkflowStage(definition, request.workflowId, request.stageId, 'worker')
    if (stage.role !== request.role) return stale('workflow-stage-mismatch')
  } catch {
    return stale('workflow-stage-mismatch')
  }

  let routeDecision
  try {
    routeDecision = parseWorkerRouteDecision(currentRouteDecision, {
      workRequest: request,
      stateVersion: current.stateVersion,
    })
  } catch {
    return stale('route-decision-invalid')
  }
  if (canonicalJson(routeDecision) !== canonicalJson(parsedProjection.routeDecision)
    || routeDecision.taskClass !== parsedProjection.routeDecision.taskClass) {
    return stale('route-decision-changed')
  }
  if (!validNow(now)) return stale('observation-time-invalid')

  /** @type {AnyObject} */
  let trustedConfig
  let currentCandidates
  try {
    trustedConfig = /** @type {AnyObject} */ (structuredClone(machineConfig))
    currentCandidates = resolveWorkerCandidates({
      config: trustedConfig,
      role: request.role,
      routeDecision,
    })
  } catch {
    return stale('candidate-resolution-failed')
  }
  if (!currentCandidates.length) return stale('no-matching-candidates')

  const snapshot = objectOrNull(capacitySnapshot)
  if (!snapshot || Object.keys(snapshot).some(key => !['generationHash', 'plans'].includes(key))
    || !SHA256.test(snapshot.generationHash || '') || !Array.isArray(snapshot.plans)
    || snapshot.plans.length !== currentCandidates.length) {
    return stale('capacity-snapshot-invalid', currentCandidates)
  }
  const availableCandidates = []
  try {
    const plans = new Map()
    for (const value of snapshot.plans) {
      const plan = parseWorkerCapacityInspection(value)
      if (plans.has(plan.workerId)) return stale('capacity-snapshot-invalid', currentCandidates, [], snapshot.generationHash)
      plans.set(plan.workerId, plan)
    }
    for (const workerId of currentCandidates) {
      const plan = plans.get(workerId)
      const worker = objectOrNull(trustedConfig?.workers?.[workerId])
      if (!plan || !worker || typeof worker.capacityGroup !== 'string') return stale('capacity-snapshot-invalid', currentCandidates, [], snapshot.generationHash)
      const identity = projectWorkerCapacityIdentity(workerId, worker)
      if (plan.capacityGroup !== worker.capacityGroup || canonicalJson(plan.identity) !== canonicalJson(identity)) {
        return stale('capacity-snapshot-invalid', currentCandidates, [], snapshot.generationHash)
      }
      if (plan.eligible && plan.startState === 'available' && plan.probeScopes.length === 0
        && plan.records.every(/** @param {AnyObject} entry */ entry => entry.record.state === 'available')) availableCandidates.push(workerId)
    }
  } catch {
    return stale('capacity-snapshot-invalid', currentCandidates, [], snapshot.generationHash)
  }
  return decision(
    identity,
    availableCandidates.length ? 'capacity-available' : 'capacity-unavailable',
    currentCandidates,
    availableCandidates,
    snapshot.generationHash,
  )
}

/** Evaluate one rebuilt wait and dispatch only an eligible exact request. */
/** @param {Record<string, any>} input @returns {Promise<Record<string, any>>} */
export async function evaluateCapacityWaitResumeAndDispatch({ dispatch, evaluate = evaluateCapacityWaitResume, ...input } = {}) {
  if (typeof dispatch !== 'function') throw new Error('Capacity resume dispatch is required')
  const result = evaluate(input)
  if (result.decision !== 'resume') return { decision: result, dispatched: false }
  const payload = repositoryDispatchBody(input.workRequest)
  const clientPayload = /** @type {Record<string, any>} */ (payload.client_payload)
  clientPayload.route_decision = input.currentRouteDecision
  await dispatch(payload)
  return { decision: result, dispatched: true }
}
