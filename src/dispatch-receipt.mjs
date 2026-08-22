import { setTimeout as delay } from 'node:timers/promises'
import { parseJson, run } from './common.mjs'

/** Dispatch one repository event and require its durable Actions run receipt. */
export async function dispatchWithReceipt({ executable, environment, repository, workflowFile, payload, requestId }) {
  const receipt = async () => parseJson((await run(executable, [
    'api', `repos/${repository}/actions/workflows/${workflowFile}/runs?event=repository_dispatch&per_page=100`,
  ], { env: environment })).stdout, `dispatch receipts for ${requestId}`)
    .workflow_runs?.some(run => typeof run.display_title === 'string' && run.display_title.endsWith(` request:${requestId}`))
  if (await receipt()) return
  await run(executable, ['api', '--method', 'POST', `repos/${repository}/dispatches`, '--input', '-'], {
    env: environment, input: JSON.stringify(payload),
  })
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    if (await receipt()) return
    if (attempt < 8) await delay(1_000)
  }
  throw new Error(`Repository dispatch ${requestId} has no durable ${workflowFile} run receipt`)
}
