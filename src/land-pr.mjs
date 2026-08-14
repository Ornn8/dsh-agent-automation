import {
  hostCredentialEnvironment,
  loadConfig,
  parseJson,
  requiredEnv,
  run,
} from './common.mjs'
import { evaluateLanding } from './landing-policy.mjs'

const repository = requiredEnv('TARGET_REPOSITORY')
const expectedHead = requiredEnv('HEAD_SHA')
const requestedNumber = Number.parseInt(process.env.PR_NUMBER || '0', 10)
const config = await loadConfig()
const githubEnvironment = hostCredentialEnvironment()

if (!config.repositories.includes(repository)) throw new Error(`${repository} is not in the runner allowlist`)
if (!/^[0-9a-f]{40}$/i.test(expectedHead)) throw new Error('HEAD_SHA must be a full commit SHA')
if (!Number.isSafeInteger(requestedNumber) || requestedNumber < 0) throw new Error('Invalid PR_NUMBER')

async function ghJson(args, description) {
  const result = await run(config.ghExecutable, args, { env: githubEnvironment })
  return parseJson(result.stdout, description)
}

let pullRequestNumber = requestedNumber
if (pullRequestNumber === 0) {
  const candidates = await ghJson([
    'pr', 'list', '--repo', repository, '--state', 'open',
    '--json', 'number,headRefOid', '--limit', '100',
  ], 'open pull requests for landing')
  const matches = candidates.filter(candidate => candidate.headRefOid === expectedHead)
  if (matches.length !== 1) {
    process.stdout.write(`Landing skipped: expected one open pull request at ${expectedHead}, found ${matches.length}.\n`)
    process.exit(0)
  }
  pullRequestNumber = matches[0].number
}

async function readPullRequest() {
  return ghJson([
    'pr', 'view', String(pullRequestNumber), '--repo', repository,
    '--json', 'state,isDraft,baseRefName,baseRefOid,headRefOid,mergeStateStatus,statusCheckRollup,url',
  ], 'pull request for landing')
}

const pullRequest = await readPullRequest()
const comments = await ghJson([
  'api', `repos/${repository}/issues/${pullRequestNumber}/comments`, '--paginate',
], 'pull request comments for landing')
const protection = await ghJson([
  'api', `repos/${repository}/branches/${encodeURIComponent(pullRequest.baseRefName)}/protection`,
], 'base branch protection')
const requiredChecks = protection.required_status_checks?.contexts || []
if (requiredChecks.length === 0) throw new Error('The base branch has no required status checks')

const decision = evaluateLanding({ pullRequest, expectedHead, requiredChecks, comments })
if (!decision.ready) {
  process.stdout.write(`Landing deferred for pull request #${pullRequestNumber}: ${decision.reason}.\n`)
  process.exit(0)
}

const current = await readPullRequest()
if (current.baseRefOid !== pullRequest.baseRefOid
  || current.headRefOid !== pullRequest.headRefOid
  || current.mergeStateStatus !== 'CLEAN') {
  throw new Error('Pull request changed after landing gates were evaluated')
}

await run(config.ghExecutable, [
  'pr', 'merge', String(pullRequestNumber), '--repo', repository,
  '--squash', '--delete-branch', '--match-head-commit', expectedHead,
], { env: githubEnvironment, tee: true })
process.stdout.write(`Landed pull request #${pullRequestNumber} at exact head ${expectedHead}.\n`)
