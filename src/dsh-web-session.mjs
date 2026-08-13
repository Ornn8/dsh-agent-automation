import { randomUUID } from 'node:crypto'

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

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

/** Call one DSH Web Host RPC method and unwrap its result. */
export async function dshRpc(baseUrl, method, payload, fetchImpl = fetch) {
  const rpcId = `github-agent-${randomUUID()}`
  const response = await fetchImpl(`${localDshWebBaseUrl(baseUrl)}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId, method, payload }),
  })
  if (!response.ok) throw new Error(`DSH Web Host ${method} returned HTTP ${response.status}`)
  const envelope = await response.json()
  if (envelope?.rpcId !== rpcId || envelope?.type !== 'server-response') {
    throw new Error(`DSH Web Host ${method} returned an invalid RPC envelope`)
  }
  if (!envelope.result?.ok) {
    const error = envelope.result?.error
    throw new Error(`DSH Web Host ${method} failed: ${error?.code || 'unknown'}: ${error?.message || 'unknown error'}`)
  }
  return envelope.result.value
}

/** Create one UI-owned DSH session and wait for its only turn to finish. */
export async function runDshWebSession({
  baseUrl,
  cwd,
  title,
  prompt,
  timeoutMs = 3 * 60 * 60 * 1000,
  pollMs = 2_000,
  fetchImpl = fetch,
  sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
}) {
  const endpoint = localDshWebBaseUrl(baseUrl)
  const created = await dshRpc(endpoint, 'session.create', { cwd }, fetchImpl)
  const sessionId = created?.sessionId
  if (typeof sessionId !== 'string' || !sessionId) throw new Error('DSH Web Host did not return a session id')
  process.stdout.write(`Created visible DSH session ${sessionId}: ${title}\n`)

  await dshRpc(endpoint, 'session.rename', { sessionId, title }, fetchImpl)
  const permission = await dshRpc(endpoint, 'session.prompt', {
    sessionId,
    mode: 'queue',
    content: [{ type: 'text', text: '/permission danger-full-access' }],
  }, fetchImpl)
  if (permission?.accepted !== true) {
    throw new Error('DSH Web Host did not accept the danger-full-access permission command')
  }
  await dshRpc(endpoint, 'session.prompt', {
    sessionId,
    mode: 'queue',
    content: [{ type: 'text', text: prompt }],
  }, fetchImpl)

  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const listed = await dshRpc(endpoint, 'session.list', {}, fetchImpl)
    const session = listed?.items?.find(item => item.sessionId === sessionId)
    if (!session) throw new Error(`Visible DSH session ${sessionId} disappeared`)
    if (!session.running) {
      const history = await dshRpc(endpoint, 'session.history', { sessionId, maxMessages: 1 }, fetchImpl)
      const turnEnd = history?.events?.map(item => item.event)
        .findLast(event => event?.type === 'turn/end')
      if (turnEnd) {
        const reason = turnEnd.data?.reason?.kind || 'unknown'
        if (reason !== 'completed') throw new Error(`Visible DSH session ${sessionId} ended with ${reason}`)
        process.stdout.write(`Visible DSH session ${sessionId} completed.\n`)
        return { sessionId, reason }
      }
    }
    await sleep(Math.min(pollMs, Math.max(1, deadline - Date.now())))
  }
  throw new Error(`Visible DSH session ${sessionId} timed out after ${timeoutMs} ms`)
}
