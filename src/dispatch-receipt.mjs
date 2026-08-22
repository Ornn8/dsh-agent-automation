import { setTimeout as delay } from 'node:timers/promises'
import { parseJson, run } from './common.mjs'

const MAX_TERMINAL_FAILURE_RUNS = 2
const ACTIVE_STATUSES = new Set(['queued', 'requested', 'waiting', 'pending', 'in_progress'])

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

/** Dispatch one repository event and require its durable Actions run receipt. */
export async function dispatchWithReceipt({
  executable, environment, repository, workflowFile, payload, requestId,
  runCommand = run, sleep = delay,
}) {
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
