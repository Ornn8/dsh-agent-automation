import { spawn } from 'node:child_process'
import readline from 'node:readline'

/** Return stale automated review task ids while preserving the newest tasks. */
export function reviewTaskIdsToArchive(threads, currentThreadId, keep = 6) {
  const reviews = threads.filter(thread => {
    const title = thread.name ?? thread.title
    return title?.startsWith('[GitHub Review] ')
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
  environment,
  keep = 6,
  timeoutMs = 60 * 60 * 1000,
}) {
  const child = spawn(node, [codexScript, 'app-server', '--listen', 'stdio://'], {
    cwd: projectCwd,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: environment,
  })
  const pending = new Map()
  let nextId = 0
  let turnId
  let finalMessage = ''
  let settled = false

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

  child.stderr.on('data', chunk => process.stderr.write(chunk))

  try {
    await call('initialize', {
      clientInfo: { name: 'dsh_github_review', title: 'DSH GitHub Review', version: '1.0.0' },
    })
    send({ method: 'initialized', params: {} })
    const started = await call('thread/start', {
      cwd: projectCwd,
      model: 'gpt-5.6-sol',
      approvalPolicy: 'never',
      sandbox: 'read-only',
      serviceName: 'dsh_github_review',
    })
    const threadId = started.thread.id
    await call('thread/name/set', { threadId, name: title })
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
      approvalPolicy: 'never',
      sandboxPolicy: { type: 'readOnly', access: { type: 'fullAccess' } },
      model: 'gpt-5.6-sol',
      effort: 'medium',
    })
    turnId = turn.turn.id
    await completion
    if (!finalMessage.trim()) throw new Error('Codex review task completed without a final assistant message')
    return { threadId, finalMessage: finalMessage.trim() }
  } finally {
    child.stdin.end()
    child.kill()
  }
}
