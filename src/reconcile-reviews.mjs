import {
  hostCredentialEnvironment,
  loadConfig,
  parseJson,
  requiredEnv,
  run,
} from './common.mjs'
import { needsExactReview } from './reconciliation-policy.mjs'

const repository = requiredEnv('TARGET_REPOSITORY')
const config = await loadConfig()
const githubEnvironment = hostCredentialEnvironment()
if (!config.repositories.includes(repository)) throw new Error(`${repository} is not in the runner allowlist`)

async function ghJson(args, description) {
  const result = await run(config.ghExecutable, args, { env: githubEnvironment })
  return parseJson(result.stdout, description)
}

const summaries = await ghJson([
  'api', `repos/${repository}/pulls?state=open&per_page=100`, '--paginate', '--slurp',
], 'open pull requests')
let dispatched = 0
for (const summary of summaries.flat()) {
  const pullRequest = await ghJson([
    'api', `repos/${repository}/pulls/${summary.number}`,
  ], `pull request #${summary.number}`)
  const comments = await ghJson([
    'api', `repos/${repository}/issues/${summary.number}/comments`, '--paginate',
  ], `pull request #${summary.number} comments`)
  const combined = await ghJson([
    'api', `repos/${repository}/commits/${pullRequest.head.sha}/status`,
  ], `pull request #${summary.number} status`)
  const reviewState = combined.statuses?.find(status => status.context === 'codex/review')?.state?.toUpperCase()
  if (!needsExactReview({ repository, pullRequest, comments, reviewState })) continue

  await run(config.ghExecutable, [
    'api', '--method', 'POST', `repos/${repository}/dispatches`,
    '-f', 'event_type=dsh-review',
    '-F', `client_payload[pr_number]=${summary.number}`,
    '-f', `client_payload[base_sha]=${pullRequest.base.sha}`,
    '-f', `client_payload[head_sha]=${pullRequest.head.sha}`,
  ], { env: githubEnvironment })
  dispatched += 1
}
process.stdout.write(`Dispatched ${dispatched} exact-pair review reconciliation request(s).\n`)
