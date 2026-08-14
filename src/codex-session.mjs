import { spawn } from 'node:child_process'
import readline from 'node:readline'

const REVIEW_SHELL_ENVIRONMENT_KEYS = [
  'COMSPEC', 'PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'TEMP',
  'TMP', 'WINDIR', 'GCM_INTERACTIVE', 'GH_CONFIG_DIR', 'GH_PROMPT_DISABLED',
  'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'GIT_TERMINAL_PROMPT',
]

function disabledEntries(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return Object.fromEntries(Object.keys(value)
    .filter(name => name !== '_default')
    .map(name => [name, { enabled: false }]))
}

/** Build the task-local Codex configuration for a credential-free reviewer shell. */
export function reviewThreadConfig(environment, effectiveConfig = {}) {
  const set = {}
  for (const name of REVIEW_SHELL_ENVIRONMENT_KEYS) {
    if (typeof environment[name] === 'string' && environment[name]) set[name] = environment[name]
  }
  return {
    shell_environment_policy: { inherit: 'none', set },
    features: { memories: false },
    memories: { generate_memories: false, use_memories: false },
    agents: { enabled: false },
    apps: {
      _default: {
        enabled: false,
        destructive_enabled: false,
        open_world_enabled: false,
      },
      ...disabledEntries(effectiveConfig.apps),
    },
    mcp_servers: disabledEntries(effectiveConfig.mcp_servers),
    plugins: disabledEntries(effectiveConfig.plugins),
    notify: [],
    web_search: 'disabled',
  }
}

/** Select the current read-only profile and its only runtime workspace roots. */
export function reviewTurnPermissions(taskCwd, reviewCwd) {
  return {
    permissions: ':read-only',
    runtimeWorkspaceRoots: [taskCwd, reviewCwd],
  }
}

/** Return stale automated review task ids while preserving the newest tasks. */
export function reviewTaskIdsToArchive(threads, currentThreadId, keep = 6) {
  const reviews = threads.filter(thread => {
    const title = thread.name ?? thread.title
    return title?.startsWith('[GitHub 审查] ') || title?.startsWith('[GitHub Review] ')
  })
  const retained = [
    currentThreadId,
    ...reviews.map(thread => thread.id).filter(id => id !== currentThreadId),
  ].slice(0, keep)
  return reviews.map(thread => thread.id).filter(id => !retained.includes(id))
}

/** Run a visible ChatGPT Desktop Codex task and return its final assistant message. */
export async function runReviewTask({
  node,
  codexScript,
  prompt,
  title,
  projectCwd,
  taskCwd = projectCwd,
  reviewCwd = projectCwd,
  environment,
  model = 'gpt-5.6-sol',
  effort = 'medium',
  keep = 6,
  timeoutMs = 60 * 60 * 1000,
  signal,
  onCreated = async () => undefined,
}) {
  if (signal?.aborted) throw new Error('Codex review task was cancelled before it started')
  const child = spawn(node, [codexScript, 'app-server', '--listen', 'stdio://'], {
    cwd: projectCwd,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: environment,
  })
  const pending = new Map()
  let nextId = 0
  let threadId
  let turnId
  let finalMessage = ''
  let settled = false
  let forceStopTimer

  function send(message) {
    child.stdin.write(`${JSON.stringify(message)}\n`)
  }

  function call(method, params) {
    const id = ++nextId
    send({ id, method, params })
    return new Promise((resolve, reject) => pending.set(id, { resolve, reject }))
  }

  const completion = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      reject(new Error(`Codex review task timed out after ${timeoutMs} ms`))
      child.kill()
    }, timeoutMs)
    const finish = (callback, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      callback(value)
    }
    const lines = readline.createInterface({ input: child.stdout })
    lines.on('line', (line) => {
      let message
      try {
        message = JSON.parse(line)
      } catch (error) {
        finish(reject, new Error(`Codex App Server emitted invalid JSON: ${error.message}`))
        return
      }
      if (message.id !== undefined && pending.has(message.id)) {
        const waiter = pending.get(message.id)
        pending.delete(message.id)
        if (message.error) waiter.reject(new Error(`${message.error.code}: ${message.error.message}`))
        else waiter.resolve(message.result)
        return
      }
      if (message.method === 'item/agentMessage/delta'
        && message.params?.turnId === turnId
        && typeof message.params?.delta === 'string') {
        finalMessage += message.params.delta
        return
      }
      if (message.method === 'item/completed'
        && message.params?.turnId === turnId
        && message.params?.item?.type === 'agentMessage'
        && typeof message.params.item.text === 'string') {
        finalMessage = message.params.item.text
        return
      }
      if (message.method === 'turn/completed' && message.params?.turn?.id === turnId) {
        if (message.params.turn.status === 'completed') finish(resolve)
        else finish(reject, new Error(`Codex review turn ended with ${message.params.turn.status}`))
      }
    })
    child.once('error', error => finish(reject, error))
    child.once('exit', (code, signal) => {
      const error = new Error(`Codex App Server exited before completion (code=${code}, signal=${signal})`)
      for (const waiter of pending.values()) waiter.reject(error)
      pending.clear()
      finish(reject, error)
    })
  })
  void completion.catch(() => undefined)

  child.stderr.on('data', chunk => process.stderr.write(chunk))

  const cancel = () => {
    if (!threadId || !turnId) {
      child.kill()
      return
    }
    try {
      send({ id: ++nextId, method: 'turn/interrupt', params: { threadId, turnId } })
      forceStopTimer = setTimeout(() => child.kill(), 5_000)
    } catch {
      child.kill()
    }
  }
  signal?.addEventListener('abort', cancel, { once: true })

  try {
    await call('initialize', {
      clientInfo: { name: 'dsh_github_review', title: 'DSH GitHub Review', version: '1.0.0' },
    })
    send({ method: 'initialized', params: {} })
    const configured = await call('config/read', { includeLayers: false })
    if (!configured?.config || typeof configured.config !== 'object') {
      throw new Error('Codex App Server did not return an effective configuration')
    }
    const profiles = await call('permissionProfile/list', {})
    if (!profiles?.data?.some(profile => profile.id === ':read-only' && profile.allowed === true)) {
      throw new Error('Codex App Server does not allow the required :read-only permission profile')
    }
    const started = await call('thread/start', {
      cwd: projectCwd,
      model,
      approvalPolicy: 'never',
      sandbox: 'read-only',
      serviceName: 'dsh_github_review',
      config: reviewThreadConfig(environment, configured.config),
    })
    threadId = started.thread.id
    await call('thread/name/set', { threadId, name: title })
    await onCreated({ sessionId: threadId })
    process.stdout.write(`ChatGPT Desktop review task created: ${threadId}\n`)

    const listed = await call('thread/list', {
      archived: false,
      limit: 100,
      sortKey: 'created_at',
      sortDirection: 'desc',
    })
    for (const staleThreadId of reviewTaskIdsToArchive(listed.data, threadId, keep)) {
      await call('thread/archive', { threadId: staleThreadId })
    }

    const turn = await call('turn/start', {
      threadId,
      input: [{ type: 'text', text: prompt }],
      cwd: taskCwd,
      approvalPolicy: 'never',
      ...reviewTurnPermissions(taskCwd, reviewCwd),
      model,
      effort,
    })
    turnId = turn.turn.id
    await completion
    if (!finalMessage.trim()) throw new Error('Codex review task completed without a final assistant message')
    return { threadId, finalMessage: finalMessage.trim() }
  } finally {
    signal?.removeEventListener('abort', cancel)
    clearTimeout(forceStopTimer)
    child.stdin.end()
    child.kill()
  }
}
