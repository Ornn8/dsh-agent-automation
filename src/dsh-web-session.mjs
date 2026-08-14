import { createHash, randomUUID } from 'node:crypto'

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])
const TRANSIENT_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN', 'ETIMEDOUT', 'UND_ERR_SOCKET'])

/** A DSH Web Host failure classified for finite controller recovery. */
export class DshWebRpcError extends Error {
  constructor(message, kind, options) {
    super(message, options)
    this.name = 'DshWebRpcError'
    this.kind = kind
  }
}

/** Classify only network failures that may safely be retried with the same RPC id. */
export function dshFailureKind(error) {
  if (error?.name === 'AbortError') return 'terminal'
  if (TRANSIENT_CODES.has(error?.code)) return 'transient'
  if (/\b(?:ECONNRESET|ECONNREFUSED|EAI_AGAIN|ETIMEDOUT|UND_ERR_SOCKET)\b/.test(String(error?.message || ''))) return 'transient'
  return 'terminal'
}

/** Validate that privileged DSH tasks are sent only to the local Web Host. */
export function localDshWebBaseUrl(value) {
  const url = new URL(value)
  if (!['http:', 'https:'].includes(url.protocol)
    || !LOOPBACK_HOSTS.has(url.hostname)
    || url.username
    || url.password
    || (url.pathname !== '/' && url.pathname !== '')) {
    throw new Error('dshWebBaseUrl must be an HTTP loopback origin')
  }
  return url.origin
}

/** Validate the complete per-session DSH model selection required before prompting. */
export function dshModelSelection(value) {
  if (!value || typeof value !== 'object') throw new Error('DSH worker must declare a model selection')
  const selection = {}
  for (const field of ['provider', 'model', 'reasoningEffort']) {
    if (typeof value[field] !== 'string' || !value[field].trim()) {
      throw new Error(`DSH worker ${field} must be a non-empty string`)
    }
    selection[field] = value[field].trim()
  }
  return selection
}

/** Derive one stable visible session and prompt identity from a controller task. */
export function dshSessionIdentity(taskId) {
  if (typeof taskId !== 'string' || !taskId.trim()) throw new Error('taskId must be a non-empty string')
  const digest = createHash('sha256').update(taskId).digest('hex')
  return {
    sessionId: `dsh-github-${digest.slice(0, 40)}`,
    promptRpcId: `github-agent-prompt-${digest}`,
  }
}

/** Call one DSH Web Host RPC method and unwrap its result. */
export async function dshRpc(baseUrl, method, payload, fetchImpl = fetch, {
  maxAttempts = 3,
  rpcId = `github-agent-${randomUUID()}`,
  sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
  signal,
} = {}) {
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) throw new Error('maxAttempts must be a positive integer')
  if (typeof rpcId !== 'string' || !rpcId) throw new Error('rpcId must be a non-empty string')
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await fetchImpl(`${localDshWebBaseUrl(baseUrl)}/api/${method}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, signal,
        body: JSON.stringify({ type: 'client-request', rpcId, method, payload }),
      })
      if (!response.ok) throw new DshWebRpcError(`DSH Web Host ${method} returned HTTP ${response.status}`, 'terminal')
      const envelope = await response.json()
      if (envelope?.rpcId !== rpcId || envelope?.type !== 'server-response') {
        throw new DshWebRpcError(`DSH Web Host ${method} returned an invalid RPC envelope`, 'terminal')
      }
      if (!envelope.result?.ok) {
        const error = envelope.result?.error
        throw new DshWebRpcError(`DSH Web Host ${method} failed: ${error?.code || 'unknown'}: ${error?.message || 'unknown error'}`, 'terminal')
      }
      return envelope.result.value
    } catch (error) {
      const kind = error instanceof DshWebRpcError ? error.kind : dshFailureKind(error)
      if (kind !== 'transient' || attempt === maxAttempts || signal?.aborted) {
        throw error instanceof DshWebRpcError ? error
          : new DshWebRpcError(`DSH Web Host ${method} ${kind} failure after ${attempt} attempt(s): ${error.message}`, kind, { cause: error })
      }
      await sleep(100 * attempt)
    }
  }
}

/** Create one UI-owned DSH session and wait for its only turn to finish. */
export async function runDshWebSession({
  baseUrl,
  taskId,
  cwd,
  title,
  prompt,
  timeoutMs = 3 * 60 * 60 * 1000,
  pollMs = 2_000,
  fetchImpl = fetch,
  sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
  now = Date.now,
  onCreated = async () => undefined,
  rpcAttempts = 3,
  signal,
  modelSelection,
  requiredSkill,
}) {
  const endpoint = localDshWebBaseUrl(baseUrl)
  const rpc = (method, payload) => dshRpc(endpoint, method, payload, fetchImpl, {
    maxAttempts: rpcAttempts, sleep, signal,
  })
  const selectedModel = dshModelSelection(modelSelection)
  const identity = dshSessionIdentity(taskId)
  const created = await rpc('session.create', { cwd, sessionId: identity.sessionId })
  const sessionId = created?.sessionId
  if (typeof sessionId !== 'string' || !sessionId) throw new Error('DSH Web Host did not return a session id')
  if (sessionId !== identity.sessionId) throw new Error('DSH Web Host returned a different preallocated session id')
  process.stdout.write(`Created visible DSH session ${sessionId}: ${title}\n`)

  try {
    await rpc('session.selectModel', { sessionId, ...selectedModel })
    await rpc('session.rename', { sessionId, title })
    if (requiredSkill) {
      const catalog = await rpc('skill.list', { sessionId })
      if (!catalog?.skills?.some(skill => skill?.name === requiredSkill)) {
        throw new Error(`Visible DSH session ${sessionId} cannot invoke required skill ${requiredSkill}`)
      }
    }
    await onCreated({ sessionId })
    const promptRecorded = async () => {
      const history = await rpc('session.history', { sessionId, maxMessages: 50 })
      return history?.events?.some(item => item.event?.type === 'user/message'
        && item.event.data?.source?.rpcId === identity.promptRpcId)
    }
    if (!await promptRecorded()) {
      try {
        await dshRpc(endpoint, 'session.prompt', {
          sessionId,
          mode: 'queue',
          content: [{ type: 'text', text: prompt }],
        }, fetchImpl, {
          maxAttempts: 1,
          rpcId: identity.promptRpcId,
          sleep,
          signal,
        })
      } catch (error) {
        if (!(error instanceof DshWebRpcError) || error.kind !== 'transient' || !await promptRecorded()) throw error
      }
    }

    const deadline = now() + timeoutMs
    while (now() < deadline) {
      if (signal?.aborted) throw new DshWebRpcError('DSH Web session cancelled by controller signal', 'terminal')
      const listed = await rpc('session.list', {})
      const session = listed?.items?.find(item => item.sessionId === sessionId)
      if (!session) throw new Error(`Visible DSH session ${sessionId} disappeared`)
      if (!session.running) {
        const history = await rpc('session.history', { sessionId, maxMessages: 1 })
        const turnEnd = history?.events?.map(item => item.event)
          .findLast(event => event?.type === 'turn/end')
        if (turnEnd) {
          const reason = turnEnd.data?.reason?.kind || 'unknown'
          if (reason !== 'completed') throw new Error(`Visible DSH session ${sessionId} ended with ${reason}`)
          process.stdout.write(`Visible DSH session ${sessionId} completed.\n`)
          return { sessionId, reason }
        }
      }
      await sleep(Math.min(pollMs, Math.max(1, deadline - now())))
    }
    throw new Error(`Visible DSH session ${sessionId} timed out after ${timeoutMs} ms`)
  } catch (error) {
    try {
      await dshRpc(endpoint, 'session.cancel', { sessionId }, fetchImpl, { maxAttempts: rpcAttempts, sleep })
    } catch (cancelError) {
      process.stderr.write(`Failed to cancel visible DSH session ${sessionId}: ${cancelError.message}\n`)
    }
    throw error
  }
}
