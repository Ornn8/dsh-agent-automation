import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { actionsCredentialEnvironment, requiredEnv } from './common.mjs'
import { dispatchWithReceipt } from './dispatch-receipt.mjs'

const SHA = /^[0-9a-f]{40}$/
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

function positiveInteger(value, name) {
  const parsed = Number.parseInt(value, 10)
  if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(parsed)) {
    throw new Error(`${name} must be a positive integer`)
  }
  return parsed
}

/** Build the one exact-pair advancement wake for a terminal review verdict. @param {{ repository: string, pullRequestNumber: number, baseSha: string, headSha: string, profileId: string, workflowId: string, sourceRunId: number, sourceRunAttempt: number, verdict: string }} value @returns {{ event_type: string, client_payload: { pull_request_number: number, base_sha: string, head_sha: string, profile_id: string, workflow_id: string, source_run_id: number, source_run_attempt: number, request_id: string } }} */
export function reviewAdvancementPayload(value) {
  if (!['pass', 'block'].includes(value.verdict)) throw new Error('Only a terminal review verdict can wake advancement')
  if (!value.repository || !Number.isSafeInteger(value.pullRequestNumber) || value.pullRequestNumber < 1
    || !SHA.test(value.baseSha) || !SHA.test(value.headSha)
    || !IDENTIFIER.test(value.profileId) || !IDENTIFIER.test(value.workflowId)
    || !Number.isSafeInteger(value.sourceRunId) || value.sourceRunId < 1
    || !Number.isSafeInteger(value.sourceRunAttempt) || value.sourceRunAttempt < 1) {
    throw new Error('Review advancement payload identity is invalid')
  }
  const requestId = `review-advance-${createHash('sha256').update([
    value.repository, value.pullRequestNumber, value.baseSha, value.headSha,
    value.profileId, value.workflowId, value.sourceRunId, value.sourceRunAttempt,
  ].join(':')).digest('hex').slice(0, 32)}`
  return {
    event_type: 'dsh-advance',
    client_payload: {
      pull_request_number: value.pullRequestNumber,
      base_sha: value.baseSha,
      head_sha: value.headSha,
      profile_id: value.profileId,
      workflow_id: value.workflowId,
      source_run_id: value.sourceRunId,
      source_run_attempt: value.sourceRunAttempt,
      request_id: requestId,
    },
  }
}

async function main() {
  const repository = requiredEnv('TARGET_REPOSITORY')
  const pullRequestNumber = positiveInteger(requiredEnv('PR_NUMBER'), 'PR_NUMBER')
  const sourceRunId = positiveInteger(requiredEnv('GITHUB_RUN_ID'), 'GITHUB_RUN_ID')
  const sourceRunAttempt = positiveInteger(requiredEnv('GITHUB_RUN_ATTEMPT'), 'GITHUB_RUN_ATTEMPT')
  const payload = reviewAdvancementPayload({
    repository,
    pullRequestNumber,
    baseSha: requiredEnv('BASE_SHA'),
    headSha: requiredEnv('HEAD_SHA'),
    profileId: requiredEnv('PROFILE_ID'),
    workflowId: requiredEnv('WORKFLOW_ID'),
    sourceRunId,
    sourceRunAttempt,
    verdict: requiredEnv('REVIEW_VERDICT'),
  })
  await dispatchWithReceipt({
    executable: process.env.GH_EXECUTABLE?.trim() || 'gh',
    environment: actionsCredentialEnvironment(),
    repository,
    workflowFile: 'agent-pr-land.yml',
    payload,
    requestId: payload.client_payload.request_id,
  })
  process.stdout.write(`Dispatched one exact-pair advancement wake ${payload.client_payload.request_id}.\n`)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main()
