import { annotateAdapterFailure } from './capacity-failure.mjs'

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
