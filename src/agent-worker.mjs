import { createHash } from 'node:crypto'
import { annotateAdapterFailure, canFailoverCapacityFailure, parseAdapterFailure } from './capacity-failure.mjs'
import { capacityEligibility, projectWorkerCapacityIdentity } from './capacity-registry.mjs'
import { capacityRecordKey, createCapacityAttempt, createCapacityRegistry } from './capacity-registry-store.mjs'
import { resolveWorkerCandidates } from './machine-config.mjs'
import { loadOrCreateLocalWorkerRoutingExecution } from './worker-routing.mjs'

const TERMINAL_OUTCOMES = new Set([
  'completed', 'blocked', 'superseded', 'timed-out', 'failed',
])

/** Normalize machine-local worker configuration around adapter identifiers. */
export function normalizeWorkerConfig(config) {
  if (config?.workers && typeof config.workers === 'object' && !Array.isArray(config.workers)) {
    if (Object.keys(config.workers).length === 0) throw new Error('workers must not be empty')
    return config
  }
  throw new Error('runner configuration must declare workers')
}

function requiredText(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} must be a non-empty string`)
  return value.trim()
}

function resolveWorker({ config, workerId, adapters }) {
  const id = requiredText(workerId, 'workerId')
  const worker = normalizeWorkerConfig(config).workers[id]
  if (!worker || typeof worker !== 'object') throw new Error(`Unknown agent worker ${id}`)
  const adapterName = requiredText(worker.adapter, `workers.${id}.adapter`)
  const adapter = adapters?.[adapterName]
  if (!adapter) throw new Error(`No adapter registered for ${adapterName}`)
  return { id, worker, adapterName, adapter }
}

function workerAttribution(id, worker, adapterName) {
  const values = adapterName === 'dsh-web'
    ? [worker.provider, worker.model, worker.reasoningEffort]
    : adapterName === 'opencode-cli'
      ? [worker.model, worker.variant]
      : ['codex-app', 'claude-code-cli'].includes(adapterName)
        ? [worker.model, worker.effort]
        : []
  if (values.some(value => typeof value !== 'string' || !value.trim() || /[\r\n`]/.test(value))) {
    throw new Error(`Worker ${id} has invalid public attribution metadata`)
  }
  const model = adapterName === 'dsh-web' ? `${values[0]}/${values[1]}` : values[0]
  const reasoning = adapterName === 'dsh-web' ? values[2] : values[1]
  const displayName = model ? `${adapterName} ${model}${reasoning ? ` (${reasoning})` : ''}` : adapterName
  if (displayName.length > 200) throw new Error(`Worker ${id} public attribution is too long`)
  return { id, adapter: adapterName, ...(model ? { model } : {}), ...(reasoning ? { reasoning } : {}), displayName }
}

/** Invoke one configured agent worker and validate its terminal receipt. */
export async function runAgentWorker({ config, workerId, invocation, adapters }) {
  const { id, worker, adapterName, adapter } = resolveWorker({ config, workerId, adapters })
  const attribution = workerAttribution(id, worker, adapterName)
  const invoke = typeof adapter === 'function' ? adapter : adapter.run
  if (typeof invoke !== 'function') throw new Error(`Adapter ${adapterName} cannot run work`)

  let sessionStarted = false
  const normalizedInvocation = {
    taskId: requiredText(invocation?.taskId, 'invocation.taskId'),
    cwd: requiredText(invocation?.cwd, 'invocation.cwd'),
    projectCwd: invocation?.projectCwd === undefined
      ? undefined
      : requiredText(invocation.projectCwd, 'invocation.projectCwd'),
    title: requiredText(invocation?.title, 'invocation.title'),
    prompt: requiredText(invocation?.prompt, 'invocation.prompt'),
    requiredSkill: invocation?.requiredSkill === undefined
      ? undefined
      : requiredText(invocation.requiredSkill, 'invocation.requiredSkill'),
    timeoutMs: invocation?.timeoutMs,
    signal: invocation?.signal,
    onStarted: async value => {
      sessionStarted = true
      return typeof invocation?.onStarted === 'function' ? invocation.onStarted(value) : undefined
    },
  }
  if (!Number.isSafeInteger(normalizedInvocation.timeoutMs) || normalizedInvocation.timeoutMs < 1) {
    throw new Error('invocation.timeoutMs must be a positive integer')
  }
  if (normalizedInvocation.signal !== undefined
    && (typeof normalizedInvocation.signal !== 'object' || typeof normalizedInvocation.signal.aborted !== 'boolean')) {
    throw new Error('invocation.signal must be an AbortSignal')
  }
  if (normalizedInvocation.requiredSkill !== undefined
    && worker.capabilities !== undefined
    && !worker.capabilities?.skills?.includes(normalizedInvocation.requiredSkill)) {
    throw new Error(`Agent worker ${id} does not implement required Skill ${normalizedInvocation.requiredSkill}`)
  }

  try {
    const value = await invoke({ workerId: id, worker, invocation: normalizedInvocation })
    const sessionId = requiredText(value?.sessionId, 'worker receipt sessionId')
    const outcome = requiredText(value?.outcome, 'worker receipt outcome')
    if (!TERMINAL_OUTCOMES.has(outcome)) throw new Error(`Unknown worker receipt outcome ${outcome}`)
    return {
      workerId: id,
      worker: attribution,
      sessionId,
      outcome,
      detail: typeof value.detail === 'string' ? value.detail : '',
      output: value.output,
      ...(value.automationResult === undefined ? {} : { automationResult: value.automationResult }),
    }
  } catch (error) {
    throw annotateAdapterFailure(error, {
      phase: sessionStarted ? 'session' : 'pre-session',
      scope: 'worker',
    })
  }
}

const DIGEST = /^[a-f0-9]{64}$/

/** @param {unknown} value @param {string} fallback @returns {string} */
function journalIdentifier(value, fallback) {
  const text = typeof value === 'string' && value.trim() ? value.trim() : fallback
  const normalized = text.replace(/[^A-Za-z0-9._:-]/g, '-').slice(0, 120)
  return /^[A-Za-z0-9]/.test(normalized) ? normalized : `work-${normalized}`
}

/** @param {Record<string, any>[]} records @returns {string} */
function capacityGenerationHash(records) {
  const vector = records.map(entry => ({
    key: entry.key,
    identity: entry.record?.capacityIdentity || null,
    generation: entry.record?.generation ?? 0,
    state: entry.record?.state || 'available',
  })).sort((left, right) => left.key.localeCompare(right.key))
  return createHash('sha256').update(JSON.stringify(vector)).digest('hex')
}

/** @param {Record<string, any>} config @param {object|undefined} provided @returns {object|null} */
function roleCapacityRegistry(config, provided) {
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

/** @param {Record<string, any>} worker @param {string} workerId @returns {{capacityGroup: string, identity: Record<string, any>}} */
function capacityWorkerSnapshot(worker, workerId) {
  return {
    capacityGroup: typeof worker.capacityGroup === 'string' && worker.capacityGroup.trim()
      ? worker.capacityGroup
      : workerId,
    identity: projectWorkerCapacityIdentity(workerId, worker),
  }
}

/** @param {object|null} registry @param {Record<string, any>} config @param {Record<string, any>} worker @param {string} workerId @param {number} now @param {string} leaseOwner @param {boolean} claimProbe @returns {Promise<Record<string, any>>} */
async function workerCapacityState(registry, config, worker, workerId, now, leaseOwner, claimProbe = true) {
  const snapshot = capacityWorkerSnapshot(worker, workerId)
  const result = {
    eligible: true,
    startState: 'available',
    capacityGeneration: 0,
    capacityGenerationHash: capacityGenerationHash([]),
    records: [],
    probe: null,
  }
  if (!registry || typeof registry.get !== 'function') return result
  const scopes = ['capacity-group', 'provider', 'model', 'worker']
  const keys = scopes.flatMap(scope => {
    if (scope === 'provider' && snapshot.identity.provider === null) return []
    if (scope === 'model' && (snapshot.identity.provider === null || snapshot.identity.model === null)) return []
    return [capacityRecordKey({ capacityGroup: snapshot.capacityGroup, scope, identity: snapshot.identity })]
  })
  if (typeof registry.claimHalfOpenProbe === 'function' && claimProbe) {
    const inspected = await registry.claimHalfOpenProbe({
      keys,
      leaseId: journalIdentifier(`${leaseOwner}-${workerId}`, 'capacity-probe'),
      owner: journalIdentifier(leaseOwner, 'role-worker'),
      now,
    })
    result.eligible = inspected.eligible
    result.startState = inspected.startState
    result.capacityGeneration = inspected.capacityGeneration
    result.records = inspected.records.map(entry => ({ key: entry.key, record: entry.record }))
    result.capacityGenerationHash = capacityGenerationHash(result.records)
    result.probe = inspected.probe
    return result
  }
  const probes = []
  for (const scope of scopes) {
    if (scope === 'provider' && snapshot.identity.provider === null) continue
    if (scope === 'model' && (snapshot.identity.provider === null || snapshot.identity.model === null)) continue
    const key = capacityRecordKey({ capacityGroup: snapshot.capacityGroup, scope, identity: snapshot.identity })
    const record = await (typeof registry.peek === 'function' ? registry.peek(key) : registry.get(key))
    if (!record) continue
    const eligibility = capacityEligibility(record, {
      configurationHash: config.configurationHash,
      credentialGeneration: config.credentialGeneration,
      now,
    })
    result.records.push({ key, record: eligibility.record })
    result.capacityGeneration = Math.max(result.capacityGeneration, eligibility.record.generation)
    if (!eligibility.eligible) {
      result.eligible = false
      result.startState = eligibility.state
      continue
    }
    if (eligibility.requiresProbe) {
      probes.push({ key, scope, generation: eligibility.record.generation })
    }
  }
  result.capacityGenerationHash = capacityGenerationHash(result.records)
  if (!result.eligible) return result
  if (probes.length > 1) {
    result.startState = 'half-open'
    result.eligible = false
    return result
  }
  if (!claimProbe) return result
  if (probes.length === 1) {
    if (typeof registry.acquireHalfOpenLease !== 'function') {
      result.eligible = false
      result.startState = 'cooldown'
      return result
    }
    const [{ key, scope, generation }] = probes
    const leaseId = journalIdentifier(`${leaseOwner}-${workerId}-${scope}`, 'capacity-probe')
    const acquired = await registry.acquireHalfOpenLease({
      key,
      leaseId,
      owner: journalIdentifier(leaseOwner, 'role-worker'),
      now,
    })
    if (!acquired) {
      result.eligible = false
      result.startState = 'half-open'
      return result
    }
    result.startState = 'half-open'
    result.capacityGeneration = Math.max(result.capacityGeneration, acquired.record?.generation ?? generation + 1)
    result.probe = { key, leaseId, scope }
  }
  return result
}

/** @param {object|null} registry @param {Record<string, any>} state @param {Record<string, any>|undefined} failure @param {number} now */
async function completeCapacityProbe(registry, state, failure, now) {
  if (!state.probe || (typeof registry?.completeHalfOpenLease !== 'function' && typeof registry?.completeHalfOpenProbe !== 'function')) return
  if (typeof registry.completeHalfOpenProbe === 'function' && Array.isArray(state.probe.leases)) {
    await registry.completeHalfOpenProbe({
      probe: state.probe,
      outcome: failure ? 'failure' : 'success',
      ...(failure ? { failure } : {}),
      now,
    })
    state.probe = null
    return
  }
  const sameScope = failure && failure.scope === state.probe.scope
  if (failure && !sameScope) {
    await registry.completeHalfOpenLease({
      key: state.probe.key,
      leaseId: state.probe.leaseId,
      outcome: 'success',
      now,
    })
    state.probe = null
    return
  }
  await registry.completeHalfOpenLease({
    key: state.probe.key,
    leaseId: state.probe.leaseId,
    outcome: failure ? 'failure' : 'success',
    ...(failure ? { failure } : {}),
    now,
  })
  state.probe = null
}

/** @param {object|null} registry @param {Record<string, any>} state @param {number} now */
async function abandonCapacityProbe(registry, state, now) {
  if (!state.probe || (typeof registry?.completeHalfOpenLease !== 'function' && typeof registry?.completeHalfOpenProbe !== 'function')) return
  if (typeof registry.completeHalfOpenProbe === 'function' && Array.isArray(state.probe.leases)) {
    await registry.completeHalfOpenProbe({ probe: state.probe, outcome: 'abandon', now })
    state.probe = null
    return
  }
  await registry.completeHalfOpenLease({
    key: state.probe.key,
    leaseId: state.probe.leaseId,
    outcome: 'abandon',
    now,
  })
  state.probe = null
}

/** @param {object|null} registry @param {Record<string, any>} input @returns {Promise<void>} */
async function appendRoleAttempt(registry, input) {
  if (typeof registry?.appendAttempt !== 'function') return
  await registry.appendAttempt(createCapacityAttempt(input))
}

/** @param {object|null} registry @param {Record<string, any>} input @returns {Promise<{claimed: boolean, duplicate: boolean, attempt?: Record<string, any>}>} */
async function claimRoleAttempt(registry, input) {
  if (typeof registry?.claimAttempt === 'function') {
    const claimed = await registry.claimAttempt(createCapacityAttempt({
      ...input,
      result: { outcome: 'claimed' },
    }))
    return {
      claimed: claimed?.claimed === true,
      duplicate: claimed?.claimed === false,
      attempt: claimed?.attempt,
    }
  }
  if (typeof registry?.appendAttempt !== 'function') return { claimed: true, duplicate: false }
  const claimed = await registry.appendAttempt(createCapacityAttempt({
    ...input,
    result: { outcome: 'claimed' },
  }))
  return { claimed: claimed?.result?.outcome === 'claimed', duplicate: false }
}

/**
 * Route one role WorkRequest across the admitted candidates. Capacity failures
 * are recorded before the next candidate is invoked; task and infrastructure
 * failures retain the existing single-Worker recovery path.
 * @param {Record<string, any>} options
 * @returns {Promise<Record<string, any>>}
 */
export async function runRoleWorker({
  config,
  role,
  workRequest,
  invocation,
  adapters,
  capacityRegistry,
  subjectStateVersion,
  trustedTaskSnapshot,
  onCandidateReady,
  requireTrustedSubject = false,
} = {}) {
  if (!['change', 'review'].includes(role)) throw new Error(`Worker routing is not available for ${String(role)}`)
  const localWorkRequest = workRequest || { requestId: invocation?.taskId, role }
  const localStateVersion = subjectStateVersion
    || (requireTrustedSubject ? undefined : DIGEST.test(config?.configurationHash || '') ? config.configurationHash : '0'.repeat(64))
  const localRoutingPolicy = config?.operations?.routing?.[role]
  const localExecution = await loadOrCreateLocalWorkerRoutingExecution({
    stateRoot: config?.operations?.stateRoot,
    workRequest: localWorkRequest,
    subjectStateVersion: localStateVersion,
    trustedTaskSnapshot: trustedTaskSnapshot || { workflowStage: role },
    routingPolicy: localRoutingPolicy,
  })
  const boundRouteDecision = localExecution.routeDecision
  const candidates = resolveWorkerCandidates({
    config,
    role,
    routeDecision: boundRouteDecision ? { route: boundRouteDecision.taskClass } : undefined,
  })
  if (!candidates.length) throw new Error(`Worker route for ${role} has no eligible candidates`)
  const registry = roleCapacityRegistry(config, capacityRegistry)
  const taskClass = boundRouteDecision?.taskClass || 'default'
  const routePolicyHash = boundRouteDecision && DIGEST.test(boundRouteDecision.policyHash || '')
    ? boundRouteDecision.policyHash
    : DIGEST.test(config?.configurationHash || '') ? config.configurationHash : '0'.repeat(64)
  const workRequestId = journalIdentifier(localWorkRequest?.requestId ?? invocation?.taskId, 'role-work')
  const attemptRoot = journalIdentifier(localExecution.routingAttemptId, 'routing-attempt')
  const startedAt = Date.now()
  const unavailable = []
  const seen = new Set()
  let claimedNewAttempt = false

  for (const workerId of candidates) {
    if (seen.has(workerId)) continue
    seen.add(workerId)
    const worker = config?.workers?.[workerId]
    if (!worker || typeof worker !== 'object' || Array.isArray(worker)) throw new Error(`Unknown agent worker ${workerId}`)
    const plannedCapacity = await workerCapacityState(registry, config, worker, workerId, Date.now(), attemptRoot, false)
    const attemptBase = {
      attemptId: journalIdentifier(`${attemptRoot}-${workerId}-${plannedCapacity.capacityGenerationHash}`, 'routing-attempt'),
      workRequestId,
      routePolicyHash,
      taskClass,
      workerId,
      capacityGroup: capacityWorkerSnapshot(worker, workerId).capacityGroup,
      capacityGeneration: plannedCapacity.capacityGeneration,
      capacityGenerationHash: plannedCapacity.capacityGenerationHash,
      startState: plannedCapacity.startState,
      startedAt,
    }
    const claim = await claimRoleAttempt(registry, attemptBase)
    if (!claim.claimed) {
      if (claim.duplicate) {
        if (claim.attempt?.result?.outcome === 'capacity-deferred') {
          unavailable.push(workerId)
          continue
        }
        return {
          version: 1,
          outcome: 'replayed',
          category: 'routing',
          reason: 'replayed',
          workRequestId,
          role,
          taskClass,
          routePolicyHash,
          candidates: [...candidates],
          unavailable,
          detail: 'This trusted routing generation was already claimed; no Worker or external authority was started.',
        }
      }
      unavailable.push(workerId)
      continue
    }
    claimedNewAttempt = true
    if (!plannedCapacity.eligible) {
      unavailable.push(workerId)
      await appendRoleAttempt(registry, {
        ...attemptBase,
        attemptId: journalIdentifier(`${attemptBase.attemptId}-result`, 'routing-attempt'),
        endedAt: Date.now(),
        result: { outcome: 'capacity-deferred', category: 'capacity', reason: 'provider-unavailable' },
      })
      continue
    }
    const capacity = await workerCapacityState(registry, config, worker, workerId, Date.now(), attemptRoot)
    let probeFinalized = false
    try {
      if (!capacity.eligible) {
        unavailable.push(workerId)
        await appendRoleAttempt(registry, {
          ...attemptBase,
          attemptId: journalIdentifier(`${attemptBase.attemptId}-result`, 'routing-attempt'),
          endedAt: Date.now(),
          result: { outcome: 'capacity-deferred', category: 'capacity', reason: 'provider-unavailable' },
        })
        probeFinalized = true
        continue
      }
      await onCandidateReady?.({ workerId, capacity, workRequest, role })
      const candidateInvocation = typeof invocation?.onStarted === 'function'
        ? {
            ...invocation,
            onStarted: value => invocation.onStarted({ ...value, workerId }),
          }
        : invocation
      const receipt = await runAgentWorker({ config, workerId, invocation: candidateInvocation, adapters })
      await completeCapacityProbe(registry, capacity, undefined, Date.now())
      probeFinalized = true
      await appendRoleAttempt(registry, {
        ...attemptBase,
        attemptId: journalIdentifier(`${attemptBase.attemptId}-result`, 'routing-attempt'),
        endedAt: Date.now(),
        result: { outcome: receipt.outcome },
      })
      return receipt
    } catch (error) {
      const failure = parseAdapterFailure(error?.adapterFailure
        ?? annotateAdapterFailure(error, { phase: 'pre-session', scope: 'worker' }).adapterFailure)
      const safeCapacityFailover = canFailoverCapacityFailure(failure)
        && (role === 'review' || (failure.phase === 'pre-session' && worker.adapter !== 'command-json'))
      if (!safeCapacityFailover) {
        await abandonCapacityProbe(registry, capacity, Date.now())
        probeFinalized = true
        await appendRoleAttempt(registry, {
          ...attemptBase,
          attemptId: journalIdentifier(`${attemptBase.attemptId}-result`, 'routing-attempt'),
          endedAt: Date.now(),
          result: { outcome: 'failed', category: failure.category, reason: failure.reason },
        })
        throw error
      }
      const probeOwnsFailure = capacity.probe?.scope === failure.scope
      if (!probeOwnsFailure && typeof registry?.recordFailure === 'function') {
        await registry.recordFailure({
          capacityGroup: capacityWorkerSnapshot(worker, workerId).capacityGroup,
          sourceWorker: workerId,
          failure,
          scope: failure.scope,
        })
      }
      await completeCapacityProbe(registry, capacity, failure, Date.now())
      probeFinalized = true
      await appendRoleAttempt(registry, {
        ...attemptBase,
        attemptId: journalIdentifier(`${attemptBase.attemptId}-result`, 'routing-attempt'),
        endedAt: Date.now(),
        result: { outcome: 'capacity-failure', category: failure.category, reason: failure.reason },
      })
    } finally {
      if (!probeFinalized) await abandonCapacityProbe(registry, capacity, Date.now())
    }
  }

  if (!claimedNewAttempt && unavailable.length === candidates.length) {
    return {
      version: 1,
      outcome: 'replayed',
      category: 'routing',
      reason: 'replayed',
      workRequestId,
      role,
      taskClass,
      routePolicyHash,
      candidates: [...candidates],
      unavailable,
      detail: 'This trusted routing generation was already deferred; no Worker or external authority was started.',
    }
  }
  return {
    version: 1,
    outcome: 'capacity-deferred',
    category: 'capacity',
    reason: 'capacity-deferred',
    workRequestId,
    role,
    taskClass,
    routePolicyHash,
    candidates: [...candidates],
    unavailable,
    detail: 'All routed Workers are currently unavailable due to capacity.',
  }
}

/** Check one worker adapter without starting an agent task or making a model call. */
export async function checkAgentWorker({ config, workerId, adapters }) {
  const { id, worker, adapterName, adapter } = resolveWorker({ config, workerId, adapters })
  if (typeof adapter !== 'object' || typeof adapter.health !== 'function') {
    throw new Error(`Adapter ${adapterName} does not expose health`)
  }
  const value = await adapter.health({ workerId: id, worker })
  return {
    workerId: id,
    detail: typeof value?.detail === 'string' ? value.detail : '',
  }
}
