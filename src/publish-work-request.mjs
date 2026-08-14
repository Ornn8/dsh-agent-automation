import {
  actionsCredentialEnvironment,
  loadConfig,
  parseJson,
  requiredEnv,
  run,
} from './common.mjs'
import { createReviewRepairRequest, repositoryDispatchBody } from './work-request.mjs'

const repository = requiredEnv('TARGET_REPOSITORY')
const pullRequestNumber = Number.parseInt(requiredEnv('PR_NUMBER'), 10)
const expectedBase = requiredEnv('BASE_SHA')
const expectedHead = requiredEnv('HEAD_SHA')
const config = await loadConfig()
const environment = actionsCredentialEnvironment()

if (!config.repositories.includes(repository)) throw new Error(`${repository} is not in the runner allowlist`)
if (!Number.isSafeInteger(pullRequestNumber) || pullRequestNumber < 1) {
  throw new Error(`Invalid PR_NUMBER: ${process.env.PR_NUMBER}`)
}

async function ghJson(args, description) {
  const result = await run(config.ghExecutable, args, { env: environment })
  return parseJson(result.stdout, description)
}

const pullRequest = await ghJson([
  'api', `repos/${repository}/pulls/${pullRequestNumber}`,
], 'pull request')
if (pullRequest.state !== 'open' || pullRequest.draft) throw new Error('Pull request is not an open ready pull request')
if (pullRequest.head?.repo?.full_name !== repository) throw new Error('Fork pull requests cannot request privileged work')
if (pullRequest.base?.sha !== expectedBase || pullRequest.head?.sha !== expectedHead) {
  throw new Error('Pull request changed before the work request was published')
}
const request = createReviewRepairRequest({
  repository,
  pullRequestNumber,
  base: expectedBase,
  head: expectedHead,
})
await run(config.ghExecutable, [
  'api', '--method', 'POST', `repos/${repository}/dispatches`, '--input', '-',
], {
  env: environment,
  input: JSON.stringify(repositoryDispatchBody(request)),
})
process.stdout.write(`Published ${request.requestId} for role ${request.role}.\n`)
