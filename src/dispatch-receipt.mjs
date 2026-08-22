import { setTimeout as delay } from 'node:timers/promises'
import { parseJson, run } from './common.mjs'

const MAX_TERMINAL_FAILURE_RUNS = 2
const ACTIVE_STATUSES = new Set(['queued', 'requested', 'waiting', 'pending', 'in_progress'])
const JOURNAL_MARKER = '<!-- dsh-capacity-dispatch-journal:v1 -->'

function receiptRunKey(run) {
  const id = Number.isSafeInteger(run?.id) && run.id > 0
    ? String(run.id)
    : `${String(run?.display_title || '')}:${String(run?.head_sha || '')}`
  const attempt = Number.isSafeInteger(run?.run_attempt) && run.run_attempt > 0
    ? String(run.run_attempt)
    : '1'
  return `${id}:${attempt}`
}

function terminalFailureRuns(runs) {
  const seen = new Set()
  return runs.filter(run => {
    if (run?.status !== 'completed' || typeof run.conclusion !== 'string' || run.conclusion === 'success') return false
    const key = receiptRunKey(run)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function positiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Dispatch journal ${name} is invalid`)
  return value
}

function validateJournalState(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || typeof value.pending !== 'boolean' || !Array.isArray(value.dispatches)
    || value.dispatches.length > MAX_TERMINAL_FAILURE_RUNS) throw new Error('Dispatch journal state is invalid')
  const seen = new Set()
  const dispatches = value.dispatches.map(entry => {
    const runId = positiveInteger(entry?.runId, 'runId')
    const runAttempt = positiveInteger(entry?.runAttempt, 'runAttempt')
    const key = `${runId}:${runAttempt}`
    if (seen.has(key)) throw new Error('Dispatch journal contains a duplicate run')
    seen.add(key)
    return { runId, runAttempt }
  })
  return { pending: value.pending, dispatches }
}

/** Parse one exact capacity dispatch journal block. */
export function parseDispatchJournal(body) {
  const matches = [...String(body || '').matchAll(new RegExp(`${JOURNAL_MARKER}\\n([^\\r\\n]+)`, 'g'))]
  if (matches.length !== 1) throw new Error('Dispatch journal marker is missing or duplicated')
  let value
  try { value = JSON.parse(matches[0][1]) } catch { throw new Error('Dispatch journal JSON is invalid') }
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== 'dispatches,pending,requestId,subject,workflowFile'
    || typeof value.requestId !== 'string' || !/^[A-Za-z0-9._:-]{1,160}$/.test(value.requestId)
    || typeof value.workflowFile !== 'string' || !/^[A-Za-z0-9_.-]{1,128}$/.test(value.workflowFile)
    || !value.subject || typeof value.subject !== 'object' || Array.isArray(value.subject)
    || Object.keys(value.subject).sort().join(',') !== 'number,type'
    || !['issue', 'pull-request'].includes(value.subject.type)) throw new Error('Dispatch journal identity is invalid')
  return {
    requestId: value.requestId,
    workflowFile: value.workflowFile,
    subject: { type: value.subject.type, number: positiveInteger(value.subject.number, 'subject number') },
    ...validateJournalState(value),
  }
}

/** Serialize one bounded exact capacity dispatch journal block. */
export function dispatchJournalBody({ requestId, workflowFile, subject, pending, dispatches }) {
  const value = { requestId, workflowFile, subject, pending, dispatches }
  parseDispatchJournal(`${JOURNAL_MARKER}\n${JSON.stringify(value)}`)
  return `${JOURNAL_MARKER}\n${JSON.stringify(value)}`
}

function setJournalBlock(body, block) {
  const text = String(body || '')
  if (text.includes(JOURNAL_MARKER)) return text.replace(new RegExp(`${JOURNAL_MARKER}\\n[^\\r\\n]+`), block)
  const terminal = text.search(/\n<!-- agent-controller-mutation:[\s\S]*\n-->$/)
  if (terminal < 0) throw new Error('Capacity status has no trusted controller marker')
  return `${text.slice(0, terminal)}\n${block}${text.slice(terminal)}`
}

/** Create a journal embedded in a trusted status comment. */
export function createDispatchJournal({
  requestId, workflowFile, subject, readComment, verifyComment, updateComment,
}) {
  let comment
  const identity = value => value.requestId === requestId && value.workflowFile === workflowFile
    && value.subject.type === subject.type && value.subject.number === subject.number
  const read = async () => {
    comment = await readComment()
    await verifyComment(comment)
    if (!String(comment?.body || '').includes(JOURNAL_MARKER)) return null
    const value = parseDispatchJournal(comment.body)
    if (!identity(value)) throw new Error(`Dispatch journal ${requestId} identifies another resume`)
    return value
  }
  const write = async state => {
    const body = setJournalBlock(comment.body, dispatchJournalBody({ requestId, workflowFile, subject, ...state }))
    await updateComment(comment.id, body)
    comment = { ...comment, body }
  }
  return {
    read,
    reserve: async () => {
      const current = await read()
      if (current?.pending) throw new Error(`Dispatch journal ${requestId} already has a pending attempt`)
      await write({ pending: true, dispatches: current?.dispatches || [] })
    },
    commit: async dispatches => {
      const current = await read()
      if (!current?.pending) throw new Error(`Dispatch journal ${requestId} has no pending attempt`)
      await write({ pending: false, dispatches })
    },
    release: async () => {
      const current = await read()
      if (current?.pending) await write({ pending: false, dispatches: current.dispatches })
    },
  }
}

/** Classify matching workflow runs without treating a failed run as durable work acceptance. */
export function dispatchReceiptState(runs) {
  const matching = Array.isArray(runs) ? runs : []
  if (matching.some(run => run?.status === 'completed' && run?.conclusion === 'success')) {
    return { kind: 'success', failureCount: 0 }
  }
  if (matching.some(run => ACTIVE_STATUSES.has(run?.status))) {
    return { kind: 'active', failureCount: 0 }
  }
  const failures = terminalFailureRuns(matching)
  return {
    kind: failures.length >= MAX_TERMINAL_FAILURE_RUNS ? 'exhausted' : failures.length ? 'failed' : 'missing',
    failureCount: failures.length,
  }
}

function matchingRun(run, requestId, workflowFile) {
  return Number.isSafeInteger(run?.id) && run.id > 0
    && Number.isSafeInteger(run?.run_attempt) && run.run_attempt > 0
    && typeof run.display_title === 'string'
    && run.display_title.endsWith(` request:${requestId}`)
    && (run.path === undefined || run.path === `.github/workflows/${workflowFile}`)
    && (run.event === undefined || run.event === 'repository_dispatch')
}

function exactRunState(runs) {
  if (runs.some(run => run.status === 'completed' && run.conclusion === 'success')) return 'success'
  if (runs.some(run => ACTIVE_STATUSES.has(run.status))) return 'active'
  if (runs.length && runs.every(run => run.status === 'completed' && run.conclusion && run.conclusion !== 'success')) return 'failed'
  return 'unknown'
}

async function dispatchWithExactJournal({
  executable, environment, repository, workflowFile, payload, requestId,
  journal, runCommand, sleep,
}) {
  const receipt = async () => parseJson((await runCommand(executable, [
    'api', `repos/${repository}/actions/workflows/${workflowFile}/runs?event=repository_dispatch&per_page=100`,
  ], { env: environment })).stdout, `dispatch receipts for ${requestId}`)
    .workflow_runs?.filter(run => matchingRun(run, requestId, workflowFile)) || []
  const exact = async entries => {
    const runs = []
    for (const entry of entries) {
      const run = parseJson((await runCommand(executable, [
        'api', `repos/${repository}/actions/runs/${entry.runId}`,
      ], { env: environment })).stdout, `dispatch run ${entry.runId}`)
      if (!matchingRun({ ...run, id: entry.runId, run_attempt: run.run_attempt }, requestId, workflowFile)
        || run.run_attempt !== entry.runAttempt) return 'unknown'
      runs.push(run)
    }
    return exactRunState(runs)
  }
  const recoverPending = async state => {
    if (!state?.pending) return state
    const known = new Set(state.dispatches.map(entry => `${entry.runId}:${entry.runAttempt}`))
    const discovered = (await receipt())
      .filter(run => !known.has(`${run.id}:${run.run_attempt}`))
      .map(run => ({ runId: run.id, runAttempt: run.run_attempt }))
    if (!discovered.length) return state
    await journal.commit([...state.dispatches, ...discovered].slice(0, MAX_TERMINAL_FAILURE_RUNS))
    return await journal.read()
  }

  let state = await journal.read()
  if (state?.pending) state = await recoverPending(state)
  if (state?.pending) throw new Error(`Dispatch journal ${requestId} has a pending run without a visible exact receipt`)
  if (!state) {
    await journal.reserve()
    state = await journal.read()
  }
  if (state.dispatches.length) {
    const status = await exact(state.dispatches)
    if (status === 'success' || status === 'active') return
    if (status !== 'failed') throw new Error(`Dispatch journal ${requestId} has an unverifiable exact run`)
    if (state.dispatches.length >= MAX_TERMINAL_FAILURE_RUNS) {
      throw new Error(`Repository dispatch ${requestId} retry budget exhausted after terminal failure`)
    }
    await journal.reserve()
    state = await journal.read()
  } else if (!state.pending) {
    await journal.reserve()
    state = await journal.read()
  }

  try {
    await runCommand(executable, ['api', '--method', 'POST', `repos/${repository}/dispatches`, '--input', '-'], {
      env: environment, input: JSON.stringify(payload),
    })
  } catch (error) {
    await journal.release().catch(() => undefined)
    throw error
  }
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    const discovered = (await receipt()).map(run => ({ runId: run.id, runAttempt: run.run_attempt }))
    const known = new Set(state.dispatches.map(entry => `${entry.runId}:${entry.runAttempt}`))
    const newEntries = discovered.filter(entry => !known.has(`${entry.runId}:${entry.runAttempt}`))
    if (newEntries.length) {
      await journal.commit([...state.dispatches, ...newEntries].slice(0, MAX_TERMINAL_FAILURE_RUNS))
      state = await journal.read()
      const status = await exact(state.dispatches)
      if (status === 'success' || status === 'active') return
      if (status === 'failed' && state.dispatches.length >= MAX_TERMINAL_FAILURE_RUNS) {
        throw new Error(`Repository dispatch ${requestId} retry budget exhausted after terminal failure`)
      }
      throw new Error(`Repository dispatch ${requestId} observed a terminal failure; a bounded retry remains`)
    }
    if (attempt < 8) await sleep(1_000)
  }
  throw new Error(`Repository dispatch ${requestId} has no durable ${workflowFile} run receipt`)
}

/** Dispatch one repository event and require its durable Actions run receipt. */
export async function dispatchWithReceipt({
  executable, environment, repository, workflowFile, payload, requestId,
  journal, runCommand = run, sleep = delay,
}) {
  if (journal) {
    return dispatchWithExactJournal({
      executable, environment, repository, workflowFile, payload, requestId,
      journal, runCommand, sleep,
    })
  }
  const receipt = async () => parseJson((await runCommand(executable, [
    'api', `repos/${repository}/actions/workflows/${workflowFile}/runs?event=repository_dispatch&per_page=100`,
  ], { env: environment })).stdout, `dispatch receipts for ${requestId}`)
    .workflow_runs?.filter(run => typeof run.display_title === 'string'
      && run.display_title.endsWith(` request:${requestId}`)) || []
  const current = async () => dispatchReceiptState(await receipt())
  const initial = await current()
  if (initial.kind === 'active' || initial.kind === 'success') return
  if (initial.kind === 'exhausted') {
    throw new Error(`Repository dispatch ${requestId} retry budget exhausted after terminal failure`)
  }
  const baselineFailureCount = initial.failureCount
  await runCommand(executable, ['api', '--method', 'POST', `repos/${repository}/dispatches`, '--input', '-'], {
    env: environment, input: JSON.stringify(payload),
  })
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    const state = await current()
    if (state.kind === 'active' || state.kind === 'success') return
    if (state.kind === 'exhausted') {
      throw new Error(`Repository dispatch ${requestId} retry budget exhausted after terminal failure`)
    }
    if (state.kind === 'failed') {
      if (state.failureCount <= baselineFailureCount) {
        if (attempt < 8) await sleep(1_000)
        continue
      }
      throw new Error(`Repository dispatch ${requestId} observed a terminal failure; a bounded retry remains`)
    }
    if (attempt < 8) await sleep(1_000)
  }
  throw new Error(`Repository dispatch ${requestId} has no durable ${workflowFile} run receipt`)
}
