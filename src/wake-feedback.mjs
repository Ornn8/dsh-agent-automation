import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  hostCredentialEnvironment,
  loadConfig,
  parseJson,
  requiredEnv,
  run,
} from './common.mjs'
import { trustedReviewFeedback } from './dispatch-policy.mjs'

const repository = requiredEnv('TARGET_REPOSITORY')
const pullRequestNumber = Number.parseInt(requiredEnv('PR_NUMBER'), 10)
const feedbackId = Number.parseInt(requiredEnv('FEEDBACK_ID'), 10)
const kind = requiredEnv('FEEDBACK_KIND')
const config = await loadConfig()

if (!config.repositories.includes(repository)) throw new Error(`${repository} is not in the runner allowlist`)
if (!Number.isSafeInteger(pullRequestNumber) || pullRequestNumber < 1) throw new Error('Invalid PR_NUMBER')
if (!Number.isSafeInteger(feedbackId) || feedbackId < 1) throw new Error('Invalid FEEDBACK_ID')
if (!['review', 'review-comment'].includes(kind)) throw new Error('Invalid FEEDBACK_KIND')

async function ghJson(args, description) {
  const result = await run(config.ghExecutable, args, { env: hostCredentialEnvironment() })
  return parseJson(result.stdout, description)
}

const feedback = kind === 'review'
  ? await ghJson([
    'api', `repos/${repository}/pulls/${pullRequestNumber}/reviews/${feedbackId}`,
  ], 'pull request review')
  : await ghJson([
    'api', `repos/${repository}/pulls/comments/${feedbackId}`,
  ], 'pull request review comment')

if (kind === 'review-comment'
  && !feedback.pull_request_url?.endsWith(`/pulls/${pullRequestNumber}`)) {
  throw new Error('Review comment does not belong to the requested pull request')
}
if (!trustedReviewFeedback({
  kind,
  association: feedback.author_association,
  state: feedback.state,
})) {
  throw new Error('Feedback is not a trusted blocking review request')
}

const pullRequest = await ghJson(['api', `repos/${repository}/pulls/${pullRequestNumber}`], 'pull request')
if (pullRequest.state !== 'open' || pullRequest.draft) throw new Error('Pull request is not open and ready')
if (pullRequest.head.repo?.full_name !== repository) throw new Error('Fork pull requests cannot reach DSH')

const script = join(dirname(fileURLToPath(import.meta.url)), 'dsh-repair.mjs')
await run(process.execPath, [script], {
  env: hostCredentialEnvironment({
    TARGET_REPOSITORY: repository,
    PR_NUMBER: String(pullRequestNumber),
    HEAD_SHA: pullRequest.head.sha,
    REPAIR_REQUEST_ID: `${kind}-${feedbackId}`,
    RUN_URL: requiredEnv('RUN_URL'),
    RUNNER_TEMP: requiredEnv('RUNNER_TEMP'),
    DSH_AGENT_CONFIG: requiredEnv('DSH_AGENT_CONFIG'),
  }),
  tee: true,
  timeoutMs: 3 * 60 * 60 * 1000,
})
