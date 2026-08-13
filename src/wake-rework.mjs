import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  hostCredentialEnvironment,
  loadConfig,
  parseJson,
  requiredEnv,
  run,
  trustedAssociation,
} from './common.mjs'
import { explicitReworkCommand } from './dispatch-policy.mjs'

const repository = requiredEnv('TARGET_REPOSITORY')
const pullRequestNumber = Number.parseInt(requiredEnv('PR_NUMBER'), 10)
const commentId = Number.parseInt(requiredEnv('COMMENT_ID'), 10)
const config = await loadConfig()
if (!config.repositories.includes(repository)) throw new Error(`${repository} is not in the runner allowlist`)
if (!Number.isSafeInteger(pullRequestNumber) || pullRequestNumber < 1) throw new Error('Invalid PR_NUMBER')
if (!Number.isSafeInteger(commentId) || commentId < 1) throw new Error('Invalid COMMENT_ID')

async function ghJson(args, description) {
  const result = await run(config.ghExecutable, args, { env: hostCredentialEnvironment() })
  return parseJson(result.stdout, description)
}

const comment = await ghJson(['api', `repos/${repository}/issues/comments/${commentId}`], 'rework comment')
if (!comment.issue_url?.endsWith(`/issues/${pullRequestNumber}`)) throw new Error('Comment does not belong to the requested pull request')
if (!trustedAssociation(comment.author_association)) throw new Error(`Untrusted comment association ${comment.author_association}`)
if (!explicitReworkCommand(comment.body)) throw new Error('Comment is not an explicit DSH rework command')

const pullRequest = await ghJson(['api', `repos/${repository}/pulls/${pullRequestNumber}`], 'pull request')
if (pullRequest.state !== 'open' || pullRequest.draft) throw new Error('Pull request is not open and ready')
if (pullRequest.head.repo?.full_name !== repository) throw new Error('Fork pull requests cannot reach DSH')

const script = join(dirname(fileURLToPath(import.meta.url)), 'dsh-repair.mjs')
await run(config.dshNode, [script], {
  env: hostCredentialEnvironment({
    TARGET_REPOSITORY: repository,
    PR_NUMBER: String(pullRequestNumber),
    HEAD_SHA: pullRequest.head.sha,
    REPAIR_REQUEST_ID: `comment-${commentId}`,
    RUN_URL: requiredEnv('RUN_URL'),
    RUNNER_TEMP: requiredEnv('RUNNER_TEMP'),
    DSH_AGENT_CONFIG: requiredEnv('DSH_AGENT_CONFIG'),
  }),
  tee: true,
  timeoutMs: 3 * 60 * 60 * 1000,
})
