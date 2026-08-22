import { requiredEnv, run } from '../src/common.mjs'
import { evaluatePullRequestSize, measureGitNumstat } from '../src/pull-request-size.mjs'

const base = requiredEnv('BASE_SHA')
const head = requiredEnv('HEAD_SHA')
const pullRequestBody = process.env.PR_BODY ?? ''
if (!/^[0-9a-f]{40}$/.test(base) || !/^[0-9a-f]{40}$/.test(head)) {
  throw new Error('BASE_SHA and HEAD_SHA must be lowercase full commit SHAs')
}

const result = await run('git', ['diff', '--numstat', '--find-renames', `${base}...${head}`])
const decision = evaluatePullRequestSize({ ...measureGitNumstat(result.stdout), pullRequestBody })
process.stdout.write(`${decision.message}\n`)
if (!decision.accepted) process.exitCode = 1
