import { actionsCredentialEnvironment, parseJson, requiredEnv, run } from './common.mjs'
import {
  evaluateLanding,
  hasTrustedExactReviewRun,
  reviewRunIdFromCheckRun,
} from './landing-policy.mjs'

const repository = requiredEnv('TARGET_REPOSITORY')
const expectedHead = requiredEnv('HEAD_SHA')
const requestedNumber = Number.parseInt(process.env.PR_NUMBER || '0', 10)
const githubExecutable = process.env.GH_EXECUTABLE?.trim() || 'gh'
const githubEnvironment = actionsCredentialEnvironment()
const defaultBranch = requiredEnv('DEFAULT_BRANCH')
const requiredCheckNames = parseJson(requiredEnv('REQUIRED_CHECKS_JSON'), 'required check names')
const trustedReview = {
  controllerRepository: requiredEnv('TRUSTED_CONTROLLER_REPOSITORY'),
  controllerSha: requiredEnv('TRUSTED_CONTROLLER_SHA'),
  workflowPath: requiredEnv('TRUSTED_REVIEW_WORKFLOW_PATH'),
}

if (!/^[0-9a-f]{40}$/i.test(expectedHead)) throw new Error('HEAD_SHA must be a full commit SHA')
if (!/^[0-9a-f]{40}$/i.test(trustedReview.controllerSha)) throw new Error('TRUSTED_CONTROLLER_SHA must be a full commit SHA')
if (!Number.isSafeInteger(requestedNumber) || requestedNumber < 0) throw new Error('Invalid PR_NUMBER')
if (!Array.isArray(requiredCheckNames) || requiredCheckNames.length < 1 || requiredCheckNames.length > 32
  || new Set(requiredCheckNames).size !== requiredCheckNames.length
  || requiredCheckNames.some(name => typeof name !== 'string' || !name.trim() || name.length > 100 || name === 'codex/review')) {
  throw new Error('REQUIRED_CHECKS_JSON must name unique independent CI checks')
}

async function ghJson(args, description) {
  const result = await run(githubExecutable, args, { env: githubEnvironment })
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
    '--json', 'number,state,isDraft,baseRefName,baseRefOid,headRefOid,mergeStateStatus,url',
  ], 'pull request for landing')
}

async function readCheckRuns() {
  const pages = await ghJson([
    'api', `repos/${repository}/commits/${expectedHead}/check-runs`, '--paginate', '--slurp',
  ], 'head check runs')
  return pages.flatMap(page => page.check_runs || [])
}

async function readLatestReviewProof(pullRequest, checkRuns) {
  const candidates = [...checkRuns]
    .filter(checkRun => checkRun.name === 'codex/review')
    .sort((left, right) => (right.id || 0) - (left.id || 0))
  for (const checkRun of candidates) {
    const runId = reviewRunIdFromCheckRun(checkRun, repository)
    if (!runId) continue
    const workflowRun = await ghJson(['api', `repos/${repository}/actions/runs/${runId}`], `review workflow run ${runId}`)
    const candidate = { checkRun, run: workflowRun }
    if (hasTrustedExactReviewRun({ pullRequest, reviewProof: candidate, trustedReview })) return candidate
  }
  return null
}

const pullRequest = await readPullRequest()
pullRequest.repository = repository
if (pullRequest.baseRefName !== defaultBranch) {
  process.stdout.write(`Landing deferred for pull request #${pullRequestNumber}: base branch is not ${defaultBranch}.\n`)
  process.exit(0)
}
const requiredChecks = requiredCheckNames.map(context => ({ context, app_id: 15368 }))

const checkRuns = await readCheckRuns()
const reviewProof = await readLatestReviewProof(pullRequest, checkRuns)

const decision = evaluateLanding({ pullRequest, expectedHead, requiredChecks, checkRuns, reviewProof, trustedReview })
if (!decision.ready) {
  process.stdout.write(`Landing deferred for pull request #${pullRequestNumber}: ${decision.reason}.\n`)
  process.exit(0)
}

const current = await readPullRequest()
current.repository = repository
if (current.baseRefName !== defaultBranch) {
  throw new Error(`Pull request base changed before merge: expected ${defaultBranch}`)
}
const currentCheckRuns = await readCheckRuns()
const currentReviewProof = await readLatestReviewProof(current, currentCheckRuns)
const currentDecision = evaluateLanding({
  pullRequest: current,
  expectedHead,
  requiredChecks,
  checkRuns: currentCheckRuns,
  reviewProof: currentReviewProof,
  trustedReview,
})
if (current.baseRefOid !== pullRequest.baseRefOid || !currentDecision.ready) {
  throw new Error(`Pull request or landing evidence changed before merge: ${currentDecision.reason}`)
}

await run(githubExecutable, [
  'pr', 'merge', String(pullRequestNumber), '--repo', repository,
  '--squash', '--delete-branch', '--match-head-commit', expectedHead,
], { env: githubEnvironment, tee: true })
process.stdout.write(`Landed pull request #${pullRequestNumber} at exact head ${expectedHead}.\n`)
