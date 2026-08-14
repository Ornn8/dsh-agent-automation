import { spawn } from 'node:child_process'
import readline from 'node:readline'

export const REVIEW_TASK_TITLE_PREFIX = '[DSH GitHub 审查] '

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

/** Negotiate every App Server capability required by the review turn. */
export function reviewInitializeParams() {
  return {
    clientInfo: { name: 'dsh_github_review', title: 'DSH GitHub Review', version: '1.0.0' },
    capabilities: { experimentalApi: true },
  }
}

/** Start a fresh review task without mutating metadata while its first turn is active. */
export async function materializeReviewTask(call, {
  prompt, projectCwd, taskCwd, reviewCwd, environment, effectiveConfig, model, effort,
}) {
  const started = await call('thread/start', {
    cwd: projectCwd,
    model,
    approvalPolicy: 'never',
    sandbox: 'read-only',
    serviceName: 'dsh_github_review',
    config: reviewThreadConfig(environment, effectiveConfig),
  })
  const threadId = started?.thread?.id
  if (typeof threadId !== 'string' || !threadId) throw new Error('Codex App Server did not create a review task')
  const turn = await call('turn/start', {
    threadId,
    input: [{ type: 'text', text: prompt }],
    cwd: taskCwd,
    approvalPolicy: 'never',
    ...reviewTurnPermissions(taskCwd, reviewCwd),
    model,
    effort,
  })
  const turnId = turn?.turn?.id
  if (typeof turnId !== 'string' || !turnId) throw new Error('Codex App Server did not start the review turn')
  return { threadId, turnId }
}

/** Return stale automated review task ids while preserving the newest tasks. */
export function reviewTaskIdsToArchive(threads, currentThreadId, keep = 6) {
  const reviews = threads.filter(thread => {
    const title = thread.name ?? thread.title
    return title?.startsWith(REVIEW_TASK_TITLE_PREFIX)
  })
  const retained = [
    currentThreadId,
    ...reviews.map(thread => thread.id).filter(id => id !== currentThreadId),
  ].slice(0, keep)
  return reviews.map(thread => thread.id).filter(id => !retained.includes(id))
}


/** Read every active task without silently truncating retention at one page. */
export async function listAllActiveThreads(call) {
  const threads = []
  const cursors = new Set()
  let cursor = null
  do {
    const listed = await call('thread/list', {
      archived: false,
      cursor,
      limit: 100,
      sortKey: 'created_at',
      sortDirection: 'desc',
    })
    if (!Array.isArray(listed?.data)) throw new Error('Codex App Server returned an invalid task list')
    threads.push(...listed.data)
    cursor = listed.nextCursor ?? null
    if (cursor !== null) {
      if (typeof cursor !== 'string' || cursors.has(cursor)) {
        throw new Error('Codex App Server returned an invalid repeated task-list cursor')
      }
      cursors.add(cursor)
    }
  } while (cursor !== null)
  return threads
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
    await call('initialize', reviewInitializeParams())
    send({ method: 'initialized', params: {} })
    const configured = await call('config/read', { includeLayers: false })
    if (!configured?.config || typeof configured.config !== 'object') {
      throw new Error('Codex App Server did not return an effective configuration')
    }
    const profiles = await call('permissionProfile/list', {})
    if (!profiles?.data?.some(profile => profile.id === ':read-only' && profile.allowed === true)) {
      throw new Error('Codex App Server does not allow the required :read-only permission profile')
    }
    const started = await materializeReviewTask(call, {
      title, prompt, projectCwd, taskCwd, reviewCwd, environment,
      effectiveConfig: configured.config, model, effort,
    })
    threadId = started.threadId
    turnId = started.turnId
    await onCreated({ sessionId: threadId })
    process.stdout.write(`ChatGPT Desktop review task created: ${threadId}\n`)

    await completion
    await call('thread/name/set', { threadId, name: title })
    await call('thread/settings/update', { threadId, cwd: projectCwd })
    const activeThreads = await listAllActiveThreads(call)
    for (const staleThreadId of reviewTaskIdsToArchive(activeThreads, threadId, keep)) {
      await call('thread/archive', { threadId: staleThreadId })
    }
    if (!finalMessage.trim()) throw new Error('Codex review task completed without a final assistant message')
    return { threadId, finalMessage: finalMessage.trim() }
  } finally {
    signal?.removeEventListener('abort', cancel)
    clearTimeout(forceStopTimer)
    child.stdin.end()
    child.kill()
  }
}
