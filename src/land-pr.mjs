import { actionsCredentialEnvironment, parseJson, requiredEnv, run } from './common.mjs'
import {
  evaluateLanding,
  hasTrustedExactReviewRun,
  normalizeMergeableStatus,
  reviewRunIdFromCheckRun,
} from './landing-policy.mjs'
import { loadTrustedWorkflowProfile } from './workflow-profile.mjs'
import { resolveGithubPrCycle } from './github-pr-cycle.mjs'
import { requireEligibleWorkflowStage } from './workflow-runtime.mjs'
import { parseReviewCheckIdentity } from './review-check.mjs'
import { trustedReviewRunProfile } from './advancement-source.mjs'
import { sameRepositoryClosingIssues } from './closing-issues.mjs'
import { writeLandingResult } from './landing-result.mjs'
import { assertVerificationContractChecks } from './verification-contract.mjs'

const repository = requiredEnv('TARGET_REPOSITORY')
const expectedHead = requiredEnv('HEAD_SHA')
const requestedNumber = Number.parseInt(process.env.PR_NUMBER || '0', 10)
const githubExecutable = process.env.GH_EXECUTABLE?.trim() || 'gh'
const githubEnvironment = actionsCredentialEnvironment()
const defaultBranch = requiredEnv('DEFAULT_BRANCH')
const requestedProfileId = requiredEnv('PROFILE_ID')
let profileId = requestedProfileId
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

function deferred(message) {
  process.stdout.write(`${message}\n`)
  writeLandingResult('deferred')
  process.exit(0)
}

function landed(message) {
  process.stdout.write(`${message}\n`)
  writeLandingResult('landed')
  process.exit(0)
}

let pullRequestNumber = requestedNumber
if (pullRequestNumber === 0) {
  const candidates = await ghJson([
    'pr', 'list', '--repo', repository, '--state', 'open',
    '--json', 'number,headRefOid', '--limit', '100',
  ], 'open pull requests for landing')
  const matches = candidates.filter(candidate => candidate.headRefOid === expectedHead)
  if (matches.length !== 1) {
    deferred(`Landing skipped: expected one open pull request at ${expectedHead}, found ${matches.length}.`)
  }
  pullRequestNumber = matches[0].number
}

async function readPullRequest() {
  const pullRequest = await ghJson([
    'pr', 'view', String(pullRequestNumber), '--repo', repository,
    '--json', 'number,state,isDraft,baseRefName,baseRefOid,headRefName,headRefOid,isCrossRepository,mergeStateStatus,mergeable,url,body,labels,closingIssuesReferences',
  ], 'pull request for landing')
  return { ...pullRequest, mergeable: normalizeMergeableStatus(pullRequest.mergeable) }
}

async function closeLinkedIssues(pullRequest) {
  const issueNumbers = sameRepositoryClosingIssues(pullRequest.closingIssuesReferences, repository)
  for (const issueNumber of issueNumbers) {
    const issue = await ghJson([
      'issue', 'view', String(issueNumber), '--repo', repository, '--json', 'number,state,url',
    ], `closing Issue #${issueNumber}`)
    if (issue.number !== issueNumber
      || issue.url !== `https://github.com/${repository}/issues/${issueNumber}`) {
      throw new Error(`Closing Issue #${issueNumber} changed before mutation`)
    }
    if (issue.state === 'OPEN') {
      await run(githubExecutable, [
        'issue', 'close', String(issueNumber), '--repo', repository, '--reason', 'completed',
      ], { env: githubEnvironment })
    }
  }
  if (issueNumbers.length > 0) {
    await run(githubExecutable, [
      'api', `repos/${repository}/dispatches`, '--method', 'POST', '--input', '-',
    ], {
      env: githubEnvironment,
      input: JSON.stringify({
        event_type: 'agent_backlog_reconcile',
        client_payload: { issue_number: 0 },
      }),
    })
  }
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
if (pullRequest.state === 'MERGED') {
  if (pullRequest.baseRefName !== defaultBranch || pullRequest.headRefOid !== expectedHead) {
    throw new Error(`Merged pull request #${pullRequestNumber} does not match the requested landing pair`)
  }
  await closeLinkedIssues(pullRequest)
  landed(`Reconciled closing Issues for merged pull request #${pullRequestNumber}.`)
}
if (pullRequest.labels?.some(label => label.name === 'automation/paused')) {
  deferred(`Landing deferred for pull request #${pullRequestNumber}: automation is paused.`)
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

async function protectedChecks(checksStage, trustedVerificationContract) {
  if (checksStage.source === 'branch-protection' && trustedVerificationContract === undefined) return []
  const protection = await ghJson([
    'api', `repos/${repository}/branches/${encodeURIComponent(defaultBranch)}/protection/required_status_checks`,
  ], `required checks for ${defaultBranch}`)
  const configured = Array.isArray(protection?.checks)
    ? protection.checks
    : (protection?.contexts || []).map(context => ({ context, app_id: null }))
  const independent = configured.filter(check => check?.context !== 'agent/review')
  assertVerificationContractChecks({
    trustedVerificationContract,
    configuredRequiredChecks: independent,
  })
  const names = checksStage.source === 'branch-protection'
    ? trustedVerificationContract.contract.requiredChecks
    : checksStage.names
  return names.map(name => {
    const matching = independent.filter(check => check.context === name)
    if (matching.length !== 1) throw new Error(`Profile check ${name} is not uniquely required by branch protection`)
    return matching[0]
  })
}
if (pullRequest.baseRefName !== defaultBranch) {
  deferred(`Landing deferred for pull request #${pullRequestNumber}: base branch is not ${defaultBranch}.`)
}
const checkRuns = await readCheckRuns()
const reviewProof = await readLatestReviewProof(pullRequest, checkRuns)
if (!reviewProof) {
  deferred(`Landing deferred for pull request #${pullRequestNumber}: no trusted exact-pair review run is available.`)
}
if (reviewProof.checkRun.status !== 'completed' || reviewProof.checkRun.conclusion !== 'success') {
  deferred(`Landing deferred for pull request #${pullRequestNumber}: the trusted exact-pair review did not pass.`)
}
const reviewIdentity = parseReviewCheckIdentity(reviewProof?.checkRun)
const reviewProfile = trustedReviewRunProfile(reviewProof.run, {
  repository,
  controllerRepository: trustedReview.controllerRepository,
  controllerSha: trustedReview.controllerSha,
  workflowPath: trustedReview.workflowPath,
  number: pullRequest.number,
  base: pullRequest.baseRefOid,
  head: expectedHead,
})
if (requestedProfileId !== 'github-pr-cycle' && requestedProfileId !== reviewProfile.profileId) {
  deferred(`Landing deferred for pull request #${pullRequestNumber}: requested Profile does not match the trusted review.`)
}
profileId = reviewProfile.profileId
const profile = await targetProfile(pullRequest.baseRefOid)
if (!reviewIdentity
  || reviewIdentity.definitionHash !== profile.definitionHash) {
  deferred(`Landing deferred for pull request #${pullRequestNumber}: the trusted review does not identify this Profile revision.`)
}
const workflowId = reviewIdentity.workflowId
const cycle = resolveGithubPrCycle(profile.definition, workflowId)
if (cycle.review.id !== reviewIdentity.stageId) {
  throw new Error(`Trusted review Stage ${reviewIdentity.stageId} does not match Workflow ${workflowId}`)
}
if (cycle.merge.mode !== 'auto') {
  deferred(`Landing deferred for pull request #${pullRequestNumber}: Profile requires manual merge.`)
}
const requiredChecks = await protectedChecks(cycle.checks, profile.verificationContract)
assertVerificationContractChecks({
  trustedVerificationContract: profile.verificationContract,
  configuredRequiredChecks: requiredChecks,
})

const decision = evaluateLanding({ pullRequest, expectedHead, requiredChecks, checkRuns, reviewProof, trustedReview })
if (!decision.ready) {
  deferred(`Landing deferred for pull request #${pullRequestNumber}: ${decision.reason}.`)
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

async function reconcileConcurrentMerge() {
  const settled = await readPullRequest()
  if (settled.state !== 'MERGED'
    || settled.baseRefName !== defaultBranch
    || settled.headRefOid !== expectedHead) return false
  await closeLinkedIssues(settled)
  process.stdout.write(`Pull request #${pullRequestNumber} was already landed at exact head ${expectedHead}.\n`)
  return true
}

let mergeResult
try {
  mergeResult = await run(githubExecutable, [
    'api', '--method', 'PUT', `repos/${repository}/pulls/${pullRequestNumber}/merge`, '--input', '-',
  ], {
    env: githubEnvironment,
    input: JSON.stringify({
      sha: expectedHead,
      merge_method: cycle.merge.strategy,
      commit_message: current.body || '',
    }),
  })
} catch (error) {
  if (await reconcileConcurrentMerge()) landed(`Pull request #${pullRequestNumber} was already landed at exact head ${expectedHead}.`)
  throw error
}
const merge = parseJson(mergeResult.stdout, 'pull request merge result')
if (merge?.merged !== true || !/^[0-9a-f]{40}$/.test(merge.sha || '')) {
  if (await reconcileConcurrentMerge()) landed(`Pull request #${pullRequestNumber} was already landed at exact head ${expectedHead}.`)
  throw new Error(`GitHub did not merge pull request #${pullRequestNumber}`)
}
await closeLinkedIssues(current)
if (cycle.merge.deleteBranch && !current.isCrossRepository && current.headRefName !== defaultBranch) {
  try {
    await run(githubExecutable, [
      'api', '--method', 'DELETE', `repos/${repository}/git/refs/heads/${current.headRefName}`,
    ], { env: githubEnvironment })
  } catch (error) {
    process.stderr.write(`Pull request #${pullRequestNumber} merged, but its source branch was not deleted: ${error.message}\n`)
  }
}
process.stdout.write(`Landed pull request #${pullRequestNumber} at exact head ${expectedHead}.\n`)
writeLandingResult('landed')
