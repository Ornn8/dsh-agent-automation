// @ts-check

import { createHash } from 'node:crypto'

import { canFailoverCapacityFailure, parseAdapterFailure } from './capacity-failure.mjs'
import { capacityEligibility } from './capacity-registry.mjs'
import { capacityRecordKey, createCapacityAttempt, createCapacityRegistry } from './capacity-registry-store.mjs'
import { resolveWorkerCandidates } from './machine-config.mjs'
import { runAgentWorker } from './agent-worker.mjs'
import { createLocalWorkerRoutingExecution } from './worker-routing.mjs'

const START_STATES = new Set(['available', 'cooldown', 'half-open', 'disabled'])
const DIGEST = /^[a-f0-9]{64}$/
const EXECUTION_CLAIMS = new WeakSet()
const EXECUTION_STATES = new WeakMap()
const ATTEMPT_CLAIMS = new WeakMap()

/** @typedef {Record<string, any>} AnyObject */

/** @param {AnyObject} value @returns {string} */
function stableDigest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

/** @param {unknown} value @param {string} fallback @returns {string} */
function boundedId(value, fallback) {
  const text = typeof value === 'string' && value.trim() ? value.trim() : fallback
  const normalized = text.replace(/[^A-Za-z0-9._:-]/g, '-').slice(0, 96)
  return /^[A-Za-z0-9]/.test(normalized) ? normalized : `work-${normalized}`
}

/** @param {AnyObject} config @param {AnyObject|null|undefined} provided @returns {AnyObject|null} */
function defaultCapacityProvider(config, provided) {
  if (provided) return provided
  const stateRoot = config?.operations?.stateRoot
  if (typeof stateRoot !== 'string' || !stateRoot.trim()
    || !DIGEST.test(config?.configurationHash || '')
    || typeof config?.credentialGeneration !== 'string' || !config.credentialGeneration.trim()) return null
  return createCapacityRegistry({
    stateRoot,
    configurationHash: config.configurationHash,
    credentialGeneration: config.credentialGeneration,
    workers: config.workers,
  })
}

/** @param {AnyObject} config @param {AnyObject|null|undefined} provided @returns {AnyObject} */
function requireCapacityProvider(config, provided) {
  const provider = defaultCapacityProvider(config, provided)
  if (!provider || typeof provider.claimAttempt !== 'function') {
    throw new Error('Worker execution admission requires a durable provider with claimAttempt')
  }
  if (typeof provider.inspect !== 'function' && typeof provider.get !== 'function') {
    throw new Error('Worker execution admission requires a trusted capacity generation source')
  }
  return provider
}

/** @param {AnyObject} worker @param {string} workerId @returns {string} */
function workerCapacityGroup(worker, workerId) {
  return typeof worker.capacityGroup === 'string' && worker.capacityGroup.trim()
    ? worker.capacityGroup
    : workerId
}

/**
 * Read one single-scope capacity decision. Half-open coordination belongs to
 * the provider; this router never claims or completes a multi-scope probe.
 * @param {AnyObject} provider
 * @param {AnyObject} config
 * @param {AnyObject} worker
 * @param {string} workerId
 * @returns {Promise<AnyObject>}
 */
async function inspectCapacity(provider, config, worker, workerId) {
  const capacityGroup = workerCapacityGroup(worker, workerId)
  if (typeof provider.inspect === 'function') {
    const value = await provider.inspect({ workerId, worker, capacityGroup })
    if (!value || !Number.isSafeInteger(value.generation) || value.generation < 0) {
      throw new Error('Capacity provider must return a trusted non-negative generation')
    }
    const state = START_STATES.has(value.state) ? value.state : value.eligible === false ? 'cooldown' : 'available'
    return {
      eligible: value.eligible !== false && value.available !== false && state === 'available',
      state,
      generation: value.generation,
      capacityGroup,
    }
  }
  const record = await provider.get(capacityRecordKey({ capacityGroup, scope: 'capacity-group' }))
  if (!record) return { eligible: true, state: 'available', generation: 0, capacityGroup }
  const eligibility = capacityEligibility(record, {
    configurationHash: config.configurationHash,
    credentialGeneration: config.credentialGeneration,
  })
  return {
    eligible: eligibility.eligible === true && eligibility.state === 'available',
    state: START_STATES.has(eligibility.state) ? eligibility.state : 'cooldown',
    generation: record.generation,
    capacityGroup,
  }
}

/** @param {AnyObject} provider @param {AnyObject} input @returns {Promise<void>} */
async function recordCapacityFailure(provider, input) {
  if (typeof provider.recordFailure !== 'function') return
  await provider.recordFailure({
    capacityGroup: input.capacityGroup,
    sourceWorker: input.workerId,
    failure: input.failure,
  })
}

/** @param {AnyObject} provider @param {AnyObject} attempt @returns {Promise<void>} */
async function appendAttempt(provider, attempt) {
  if (typeof provider.appendAttempt === 'function') await provider.appendAttempt(attempt)
}

/** @param {AnyObject} input @returns {AnyObject} */
function attemptIdentity(input) {
  const capacityGenerationHash = stableDigest({
    capacityGroup: input.capacityGroup,
    generation: input.capacityGeneration,
    state: input.startState,
  })
  const identity = {
    routingAttemptId: input.routingAttemptId,
    workRequestId: input.workRequestId,
    routePolicyHash: input.routePolicyHash,
    taskClass: input.taskClass,
    workerId: input.workerId,
    capacityGroup: input.capacityGroup,
    capacityGeneration: input.capacityGeneration,
    capacityGenerationHash,
  }
  return {
    ...identity,
    attemptId: `attempt-${stableDigest(identity).slice(0, 64)}`,
    startState: input.startState,
  }
}

/** @param {AnyObject} base @param {AnyObject} result @returns {AnyObject} */
function journalEntry(base, result) {
  return createCapacityAttempt({
    ...base,
    attemptId: result.outcome === 'claimed' ? base.attemptId : boundedId(`${base.attemptId}-result`, 'attempt-result'),
    startedAt: base.startedAt,
    endedAt: result.outcome === 'claimed' ? null : Date.now(),
    result,
  })
}

/** @param {AnyObject} state @param {string} workerId @returns {Promise<AnyObject>} */
async function prepareAttempt(state, workerId) {
  const worker = state.config?.workers?.[workerId]
  if (!worker || typeof worker !== 'object' || Array.isArray(worker)) throw new Error(`Unknown agent worker ${workerId}`)
  const capacity = await inspectCapacity(state.provider, state.config, worker, workerId)
  const base = attemptIdentity({
    routingAttemptId: state.execution.routingAttemptId,
    workRequestId: state.workRequestId,
    routePolicyHash: state.execution.routeDecision.policyHash,
    taskClass: state.execution.routeDecision.taskClass,
    workerId,
    capacityGroup: capacity.capacityGroup,
    capacityGeneration: capacity.generation,
    startState: capacity.state,
  })
  base.startedAt = Date.now()
  const claim = Object.freeze({})
  ATTEMPT_CLAIMS.set(claim, { state, base, capacity, workerId })
  return { claim, capacity }
}

/** @param {AnyObject} state @param {object} claim @returns {Promise<AnyObject>} */
async function claimAttempt(state, claim) {
  const prepared = ATTEMPT_CLAIMS.get(claim)
  if (!prepared || prepared.state !== state) throw new Error('Worker execution claim is not locally trusted')
  const result = await state.provider.claimAttempt(journalEntry(prepared.base, { outcome: 'claimed' }))
  if (!result || typeof result.claimed !== 'boolean') throw new Error('Durable claimAttempt returned an invalid result')
  return { ...result, prepared }
}

/** @param {AnyObject} state @param {object} claim @param {AnyObject} result @returns {Promise<void>} */
async function finishAttempt(state, claim, result) {
  const prepared = ATTEMPT_CLAIMS.get(claim)
  if (!prepared || prepared.state !== state) throw new Error('Worker execution claim is not locally trusted')
  await appendAttempt(state.provider, journalEntry(prepared.base, result))
}

/** @param {AnyObject} state @param {object} claim @param {AnyObject} failure @returns {Promise<void>} */
async function recordAttemptFailure(state, claim, failure) {
  const prepared = ATTEMPT_CLAIMS.get(claim)
  if (!prepared || prepared.state !== state) throw new Error('Worker execution claim is not locally trusted')
  await recordCapacityFailure(state.provider, {
    workerId: prepared.workerId,
    capacityGroup: prepared.capacity.capacityGroup,
    failure,
  })
}

/**
 * Create an opaque Worker execution admission token. The token binds the
 * trusted local route decision to the provider-owned capacity generation.
 * @param {AnyObject} options
 * @returns {object}
 */
export function createWorkerExecutionClaim(options = {}) {
  if (Object.prototype.hasOwnProperty.call(options, 'generation')) {
    throw new Error('Worker execution generation is provider-owned')
  }
  const {
    config,
    role,
    workRequest,
    routeDecision,
    subjectStateVersion,
    trustedTaskSnapshot,
    routingPolicy,
    capacityProvider,
    capacityRegistry,
  } = options
  if (typeof workRequest?.requestId !== 'string' || !workRequest.requestId.trim()) {
    throw new Error('Worker execution claim requires a trusted WorkRequest id')
  }
  if (!['change', 'review'].includes(role)) throw new Error(`Worker routing is not available for ${String(role)}`)
  const policy = routingPolicy ?? config?.operations?.routing?.[role]
  const provider = requireCapacityProvider(config, capacityProvider ?? capacityRegistry)
  const execution = createLocalWorkerRoutingExecution({
    routeDecision,
    workRequest,
    subjectStateVersion,
    trustedTaskSnapshot: trustedTaskSnapshot ?? { workflowStage: role },
    routingPolicy: policy,
  })
  const candidates = resolveWorkerCandidates({
    config,
    role,
    routeDecision: { taskClass: execution.routeDecision.taskClass },
  })
  if (!candidates.length) throw new Error(`Worker route for ${role} has no eligible candidates`)
  const token = Object.freeze({})
  const state = {
    config,
    role,
    provider,
    execution,
    candidates: [...candidates],
    workRequest,
    workRequestId: boundedId(workRequest.requestId, 'role-work'),
  }
  EXECUTION_CLAIMS.add(token)
  EXECUTION_STATES.set(token, state)
  return token
}

/** Create an opaque Worker execution admission allocator. */
export function createWorkerExecutionAllocator(options = {}) {
  return createWorkerExecutionClaim(options)
}

/**
 * Route one admitted WorkRequest through its local role pool. Production code
 * must supply the opaque token returned by createWorkerExecutionClaim.
 * @param {AnyObject} options
 * @returns {Promise<AnyObject>}
 */
export async function runRoleWorker({ executionClaim, invocation, adapters } = {}) {
  if (!EXECUTION_CLAIMS.has(executionClaim)) {
    throw new Error('runRoleWorker requires an opaque Worker execution claim')
  }
  const state = EXECUTION_STATES.get(executionClaim)
  const attempted = new Set()
  const unavailable = []

  for (const workerId of state.candidates) {
    if (attempted.has(workerId)) continue
    attempted.add(workerId)
    const prepared = await prepareAttempt(state, workerId)
    const admission = await claimAttempt(state, prepared.claim)
    if (admission.claimed === false) {
      return {
        version: 1,
        outcome: 'replayed',
        category: 'routing',
        reason: 'replayed',
        workRequestId: state.workRequestId,
        role: state.role,
        taskClass: state.execution.routeDecision.taskClass,
        routingAttemptId: state.execution.routingAttemptId,
        candidates: [...state.candidates],
        detail: 'This trusted routing claim was already durably claimed; no Worker was started.',
      }
    }
    if (!prepared.capacity.eligible) {
      unavailable.push(workerId)
      await finishAttempt(state, prepared.claim, {
        outcome: 'capacity-deferred', category: 'capacity', reason: 'provider-unavailable',
      })
      continue
    }
    let candidateStarted = false
    const candidateInvocation = {
      ...invocation,
      onStarted: /** @param {AnyObject} value */ async value => {
        candidateStarted = true
        return typeof invocation?.onStarted === 'function' ? invocation.onStarted(value) : undefined
      },
    }
    try {
      const receipt = await runAgentWorker({ config: state.config, workerId, invocation: candidateInvocation, adapters })
      await finishAttempt(state, prepared.claim, { outcome: receipt.outcome })
      return receipt
    } catch (error) {
      const failureSource = error && typeof error === 'object' && 'adapterFailure' in error
        ? error.adapterFailure
        : error
      let failure
      try {
        failure = parseAdapterFailure(failureSource)
      } catch {
        failure = parseAdapterFailure({
          version: 1,
          category: 'task',
          reason: 'task-failure',
          scope: 'worker',
          phase: candidateStarted ? 'session' : 'pre-session',
          code: 'worker.routing-failure',
          confidence: 'authoritative',
        })
      }
      const canContinue = !candidateStarted
        && failure.phase === 'pre-session'
        && failure.scope === 'capacity-group'
        && failure.confidence === 'authoritative'
        && canFailoverCapacityFailure(failure)
      if (!canContinue) {
        await finishAttempt(state, prepared.claim, {
          outcome: 'failed', category: failure.category, reason: failure.reason,
        })
        throw error
      }
      await recordAttemptFailure(state, prepared.claim, failure)
      await finishAttempt(state, prepared.claim, {
        outcome: 'capacity-failure', category: failure.category, reason: failure.reason,
      })
    }
  }

  return {
    version: 1,
    outcome: 'capacity-deferred',
    category: 'capacity',
    reason: 'capacity-deferred',
    workRequestId: state.workRequestId,
    role: state.role,
    taskClass: state.execution.routeDecision.taskClass,
    routingAttemptId: state.execution.routingAttemptId,
    candidates: [...state.candidates],
    unavailable,
    detail: 'All routed Workers are currently unavailable due to capacity.',
  }
}
