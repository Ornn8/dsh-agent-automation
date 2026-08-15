import { fileURLToPath } from 'node:url'
import { actionsCredentialEnvironment, parseJson, requiredEnv, run } from './common.mjs'

const repository = requiredEnv('TARGET_REPOSITORY')
const defaultBranch = requiredEnv('DEFAULT_BRANCH')
const githubExecutable = process.env.GH_EXECUTABLE?.trim() || 'gh'
const githubEnvironment = actionsCredentialEnvironment()
const landScript = fileURLToPath(new URL('./land-pr.mjs', import.meta.url))

const result = await run(githubExecutable, [
  'pr', 'list', '--repo', repository, '--state', 'open',
  '--json', 'number,headRefOid,baseRefName,isDraft', '--limit', '101',
], { env: githubEnvironment })
const pullRequests = parseJson(result.stdout, 'open pull requests for landing reconciliation')
if (pullRequests.length > 100) throw new Error('Landing reconciliation exceeded its bounded 100 pull request snapshot')

for (const pullRequest of pullRequests) {
  if (pullRequest.isDraft || pullRequest.baseRefName !== defaultBranch) continue
  await run(process.execPath, [landScript], {
    env: {
      ...process.env,
      PR_NUMBER: String(pullRequest.number),
      HEAD_SHA: pullRequest.headRefOid,
    },
    tee: true,
  })
}
