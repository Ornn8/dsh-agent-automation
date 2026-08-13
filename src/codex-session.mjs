import { spawn } from 'node:child_process'
import readline from 'node:readline'

/** Name a completed Codex task and archive older automated review tasks. */
export async function retainReviewSessions({ node, codexScript, threadId, title, projectCwd, keep = 6 }) {
  const child = spawn(node, [codexScript, 'app-server', '--listen', 'stdio://'], {
    cwd: projectCwd,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, NO_COLOR: '1' },
  })
  const pending = new Map()
  let nextId = 0
  const lines = readline.createInterface({ input: child.stdout })
  const timeout = setTimeout(() => {
    for (const waiter of pending.values()) waiter.reject(new Error('Codex task retention timed out'))
    pending.clear()
    child.kill()
  }, 20_000)
  lines.on('line', (line) => {
    let message
    try {
      message = JSON.parse(line)
    } catch {
      return
    }
    if (message.id === undefined || !pending.has(message.id)) return
    const waiter = pending.get(message.id)
    pending.delete(message.id)
    if (message.error) waiter.reject(new Error(message.error.message))
    else waiter.resolve(message.result)
  })

  function call(method, params) {
    const id = ++nextId
    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`)
    return new Promise((resolve, reject) => pending.set(id, { resolve, reject }))
  }

  try {
    await call('initialize', {
      clientInfo: { name: 'dsh_github_review_retention', title: 'DSH GitHub Review Retention', version: '1.0.0' },
    })
    child.stdin.write(`${JSON.stringify({ method: 'initialized', params: {} })}\n`)
    await call('thread/name/set', { threadId, name: title })
    const listed = await call('thread/list', {
      archived: false,
      limit: 100,
      sortKey: 'created_at',
      sortDirection: 'desc',
    })
    const reviews = listed.data.filter(thread => thread.name?.startsWith('[GitHub Review] '))
    for (const thread of reviews.slice(keep)) {
      await call('thread/archive', { threadId: thread.id })
    }
  } finally {
    clearTimeout(timeout)
    lines.close()
    child.stdin.end()
    child.kill()
  }
}

