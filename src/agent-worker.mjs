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

/** Invoke one configured agent worker and validate its terminal receipt. */
export async function runAgentWorker({ config, workerId, invocation, adapters }) {
  const { id, worker, adapterName, adapter } = resolveWorker({ config, workerId, adapters })
  const invoke = typeof adapter === 'function' ? adapter : adapter.run
  if (typeof invoke !== 'function') throw new Error(`Adapter ${adapterName} cannot run work`)

  const normalizedInvocation = {
    taskId: requiredText(invocation?.taskId, 'invocation.taskId'),
    cwd: requiredText(invocation?.cwd, 'invocation.cwd'),
    title: requiredText(invocation?.title, 'invocation.title'),
    prompt: requiredText(invocation?.prompt, 'invocation.prompt'),
    requiredSkill: invocation?.requiredSkill === undefined
      ? undefined
      : requiredText(invocation.requiredSkill, 'invocation.requiredSkill'),
    timeoutMs: invocation?.timeoutMs,
    signal: invocation?.signal,
    onStarted: typeof invocation?.onStarted === 'function' ? invocation.onStarted : async () => undefined,
  }
  if (!Number.isSafeInteger(normalizedInvocation.timeoutMs) || normalizedInvocation.timeoutMs < 1) {
    throw new Error('invocation.timeoutMs must be a positive integer')
  }
  if (normalizedInvocation.signal !== undefined
    && (typeof normalizedInvocation.signal !== 'object' || typeof normalizedInvocation.signal.aborted !== 'boolean')) {
    throw new Error('invocation.signal must be an AbortSignal')
  }

  const value = await invoke({ workerId: id, worker, invocation: normalizedInvocation })
  const sessionId = requiredText(value?.sessionId, 'worker receipt sessionId')
  const outcome = requiredText(value?.outcome, 'worker receipt outcome')
  if (!TERMINAL_OUTCOMES.has(outcome)) throw new Error(`Unknown worker receipt outcome ${outcome}`)
  return {
    workerId: id,
    sessionId,
    outcome,
    detail: typeof value.detail === 'string' ? value.detail : '',
    output: value.output,
    ...(value.automationResult === undefined ? {} : { automationResult: value.automationResult }),
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
