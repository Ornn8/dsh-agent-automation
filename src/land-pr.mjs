import { actionsCredentialEnvironment, parseJson, requiredEnv, run } from './common.mjs'
import {
  evaluateLanding,
  hasTrustedExactReviewRun,
  reviewRunIdFromCheckRun,
} from './landing-policy.mjs'
import { loadTrustedWorkflowProfile } from './workflow-profile.mjs'
import { resolveGithubPrCycle } from './github-pr-cycle.mjs'
import { requireEligibleWorkflowStage } from './workflow-runtime.mjs'
import { parseReviewCheckIdentity } from './review-check.mjs'

const repository = requiredEnv('TARGET_REPOSITORY')
const expectedHead = requiredEnv('HEAD_SHA')
const requestedNumber = Number.parseInt(process.env.PR_NUMBER || '0', 10)
const githubExecutable = process.env.GH_EXECUTABLE?.trim() || 'gh'
const githubEnvironment = actionsCredentialEnvironment()
const defaultBranch = requiredEnv('DEFAULT_BRANCH')
const profileId = requiredEnv('PROFILE_ID')
const trustedReview = {
  controllerRepository: requiredEnv('TRUSTED_CONTROLLER_REPOSITORY'),
  controllerSha: requiredEnv('TRUSTED_CONTROLLER_SHA'),
  workflowPath: requiredEnv('TRUSTED_REVIEW_WORKFLOW_PATH'),
}

if (!/^[0-9a-f]{40}$/i.test(expectedHead)) throw new Error('HEAD_SHA must be a full commit SHA')
if (!/^[0-9a-f]{40}$/i.test(trustedReview.controllerSha)) throw new Error('TRUSTED_CONTROLLER_SHA must be a full commit SHA')
if (!Number.isSafeInteger(requestedNumber) || requestedNumber < 0) throw new Error('Invalid PR_NUMBER')
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
    '--json', 'number,state,isDraft,baseRefName,baseRefOid,headRefOid,mergeStateStatus,url,body,labels',
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
    .filter(checkRun => checkRun.name === 'agent/review')
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
if (pullRequest.labels?.some(label => label.name === 'automation/paused')) {
  process.stdout.write(`Landing deferred for pull request #${pullRequestNumber}: automation is paused.\n`)
  process.exit(0)
}

async function targetProfile(revision) {
  return loadTrustedWorkflowProfile({
    repository,
    revision,
    profileId,
    loadContent: async ({ path, revision: exactRevision }) => {
      const content = await ghJson([
        'api', '--method', 'GET', `repos/${repository}/contents/${path}`, '-f', `ref=${exactRevision}`,
      ], `Profile ${profileId} at ${exactRevision}`)
      if (content?.encoding !== 'base64' || typeof content.content !== 'string') {
        throw new Error(`Profile ${profileId} is not a GitHub file`)
      }
      return Buffer.from(content.content.replace(/\s/g, ''), 'base64').toString('utf8')
    },
  })
}

async function protectedChecks(checksStage) {
  const protection = await ghJson([
    'api', `repos/${repository}/branches/${encodeURIComponent(defaultBranch)}/protection/required_status_checks`,
  ], `required checks for ${defaultBranch}`)
  const configured = Array.isArray(protection?.checks)
    ? protection.checks
    : (protection?.contexts || []).map(context => ({ context, app_id: null }))
  const independent = configured.filter(check => check?.context !== 'agent/review')
  if (checksStage.source === 'branch-protection') return independent
  return checksStage.names.map(name => {
    const matching = independent.filter(check => check.context === name)
    if (matching.length !== 1) throw new Error(`Profile check ${name} is not uniquely required by branch protection`)
    return matching[0]
  })
}
if (pullRequest.baseRefName !== defaultBranch) {
  process.stdout.write(`Landing deferred for pull request #${pullRequestNumber}: base branch is not ${defaultBranch}.\n`)
  process.exit(0)
}
const profile = await targetProfile(pullRequest.baseRefOid)
const checkRuns = await readCheckRuns()
const reviewProof = await readLatestReviewProof(pullRequest, checkRuns)
const reviewIdentity = parseReviewCheckIdentity(reviewProof?.checkRun)
if (!reviewIdentity
  || reviewIdentity.definitionHash !== profile.definitionHash) {
  process.stdout.write(`Landing deferred for pull request #${pullRequestNumber}: the trusted review does not identify this Profile revision.\n`)
  process.exit(0)
}
const workflowId = reviewIdentity.workflowId
const cycle = resolveGithubPrCycle(profile.definition, workflowId)
if (cycle.review.id !== reviewIdentity.stageId) {
  throw new Error(`Trusted review Stage ${reviewIdentity.stageId} does not match Workflow ${workflowId}`)
}
if (cycle.merge.mode !== 'auto') {
  process.stdout.write(`Landing deferred for pull request #${pullRequestNumber}: Profile requires manual merge.\n`)
  process.exit(0)
}
const requiredChecks = await protectedChecks(cycle.checks)

const decision = evaluateLanding({ pullRequest, expectedHead, requiredChecks, checkRuns, reviewProof, trustedReview })
if (!decision.ready) {
  process.stdout.write(`Landing deferred for pull request #${pullRequestNumber}: ${decision.reason}.\n`)
  process.exit(0)
}

const current = await readPullRequest()
current.repository = repository
if (current.labels?.some(label => label.name === 'automation/paused')) {
  throw new Error(`Pull request #${pullRequestNumber} became paused before merge`)
}
requireEligibleWorkflowStage(
  profile.definition,
  workflowId,
  cycle.merge.id,
  [cycle.change.id, cycle.review.id, cycle.checks.id],
)
if (current.baseRefName !== defaultBranch) {
  throw new Error(`Pull request base changed before merge: expected ${defaultBranch}`)
}
const currentCheckRuns = await readCheckRuns()
const currentReviewProof = await readLatestReviewProof(current, currentCheckRuns)
const currentReviewIdentity = parseReviewCheckIdentity(currentReviewProof?.checkRun)
const currentDecision = evaluateLanding({
  pullRequest: current,
  expectedHead,
  requiredChecks,
  checkRuns: currentCheckRuns,
  reviewProof: currentReviewProof,
  trustedReview,
})
if (current.baseRefOid !== pullRequest.baseRefOid
  || currentReviewIdentity?.workflowId !== reviewIdentity.workflowId
  || currentReviewIdentity?.stageId !== reviewIdentity.stageId
  || currentReviewIdentity?.definitionHash !== reviewIdentity.definitionHash
  || !currentDecision.ready) {
  throw new Error(`Pull request or landing evidence changed before merge: ${currentDecision.reason}`)
}

const mergeArguments = [
  'pr', 'merge', String(pullRequestNumber), '--repo', repository,
  `--${cycle.merge.strategy}`,
  ...(cycle.merge.deleteBranch ? ['--delete-branch'] : []),
  '--match-head-commit', expectedHead,
  '--body', current.body || '',
]
await run(githubExecutable, mergeArguments, { env: githubEnvironment, tee: true })
process.stdout.write(`Landed pull request #${pullRequestNumber} at exact head ${expectedHead}.\n`)
