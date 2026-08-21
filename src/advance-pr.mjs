import { fileURLToPath } from 'node:url'
import { actionsCredentialEnvironment, parseJson, requiredEnv, run } from './common.mjs'
import { decidePullRequestAdvancement } from './advancement-policy.mjs'
import { buildPullRequestAdvancementSnapshot } from './advancement-state.mjs'
import {
  advancementRepairCandidate,
  advancementTransitionIdentity,
  consumePullRequestAdvancement,
} from './advancement-runtime.mjs'
import { landingResult } from './landing-result.mjs'
import { hasTrustedExactReviewInvocation } from './landing-policy.mjs'
import { loadTrustedWorkflowProfile } from './workflow-profile.mjs'
import {
  attestedGovernorRecordBody,
  GOVERNOR_WORKFLOW_PATHS,
  pullRequestGovernorSubject,
  trustedGovernorRecords,
} from './governor-state.mjs'
import { reviewFaultAttemptEndpoints, verifyReviewFaultAttempt } from './review-fault-audit.mjs'
import { parseReviewCheckIdentity } from './review-check.mjs'
import { terminalReviewSource, trustedReviewRunProfile } from './advancement-source.mjs'
import { dispatchWithReceipt } from './dispatch-receipt.mjs'
import { trustedWorkerIdentity } from './workflow-identity.mjs'
import { createWorkerRoutingExecution } from './worker-routing.mjs'

const repository = requiredEnv('TARGET_REPOSITORY')
const requestedNumber = Number.parseInt(process.env.PR_NUMBER || '0', 10)
let expectedBase = process.env.BASE_SHA?.trim().toLowerCase() || ''
let expectedHead = process.env.HEAD_SHA?.trim().toLowerCase() || ''
const defaultBranch = requiredEnv('DEFAULT_BRANCH')
const requestedProfileId = process.env.PROFILE_ID?.trim() || ''
let profileId = requestedProfileId
let requestedWorkflowId = process.env.WORKFLOW_ID?.trim() || ''
const trustedControllerLogin = requiredEnv('TRUSTED_CONTROLLER_LOGIN')
const sourceRunId = Number.parseInt(process.env.SOURCE_RUN_ID || '0', 10)
const sourceRunAttempt = Number.parseInt(process.env.SOURCE_RUN_ATTEMPT || '0', 10)
const trustedReview = {
  controllerRepository: requiredEnv('TRUSTED_CONTROLLER_REPOSITORY'),
  controllerSha: requiredEnv('TRUSTED_CONTROLLER_SHA').toLowerCase(),
  workflowPath: requiredEnv('TRUSTED_REVIEW_WORKFLOW_PATH'),
}
const requiredChecks = parseJson(requiredEnv('REQUIRED_CHECKS_JSON'), 'configured required checks')
const githubExecutable = process.env.GH_EXECUTABLE?.trim() || 'gh'
const environment = actionsCredentialEnvironment()
const landScript = fileURLToPath(new URL('./land-pr.mjs', import.meta.url))
const governorWorkflowPath = requiredEnv('GOVERNOR_WORKFLOW_PATH')
const runId = Number.parseInt(requiredEnv('GITHUB_RUN_ID'), 10)
const routingPolicy = process.env.WORKER_ROUTING_POLICY_JSON?.trim()
  ? parseJson(process.env.WORKER_ROUTING_POLICY_JSON, 'worker routing policy')
  : { version: 1, defaultRoute: 'default', routes: { default: {} } }

if (!Number.isSafeInteger(requestedNumber) || requestedNumber < 0) throw new Error('Invalid PR_NUMBER')
if (!Number.isSafeInteger(sourceRunId) || sourceRunId < 0
  || !Number.isSafeInteger(sourceRunAttempt) || sourceRunAttempt < 0
  || Boolean(sourceRunId) !== Boolean(sourceRunAttempt)) {
  throw new Error('Advancement source workflow identity is invalid')
}
if (!Number.isSafeInteger(runId) || runId < 1 || !GOVERNOR_WORKFLOW_PATHS.includes(governorWorkflowPath)) {
  throw new Error('Advancement Governor writer provenance is invalid')
}
if (!Array.isArray(requiredChecks) || requiredChecks.length < 1 || requiredChecks.length > 32
  || requiredChecks.some(required => {
    if (typeof required === 'string') return !required.trim() || required === 'agent/review'
    return !required || typeof required !== 'object' || typeof required.context !== 'string'
      || !required.context.trim() || required.context === 'agent/review'
      || (required.app_id !== undefined && required.app_id !== null
        && (!Number.isSafeInteger(required.app_id) || required.app_id < 1))
  })) {
  throw new Error('REQUIRED_CHECKS_JSON must contain configured non-review check definitions')
}

async function ghJson(args, description) {
  const result = await run(githubExecutable, args, { env: environment })
  return parseJson(result.stdout, description)
}

async function resolveTerminalReviewSource() {
  if (!sourceRunId) return null
  const source = await ghJson(['api', `repos/${repository}/actions/runs/${sourceRunId}`], 'advancement source workflow run')
  return terminalReviewSource(source, {
    runId: sourceRunId,
    runAttempt: sourceRunAttempt,
    repository,
    controllerRepository: trustedReview.controllerRepository,
    controllerSha: trustedReview.controllerSha,
    workflowPath: trustedReview.workflowPath,
  })
}

const verifiedTerminalReviewSource = await resolveTerminalReviewSource()
if (verifiedTerminalReviewSource) {
  if (profileId && profileId !== verifiedTerminalReviewSource.profileId) {
    throw new Error('Advancement source review Profile does not match the requested Profile')
  }
  profileId = verifiedTerminalReviewSource.profileId
}
let pullRequestNumber = verifiedTerminalReviewSource?.number || requestedNumber
if (verifiedTerminalReviewSource) {
  expectedBase = verifiedTerminalReviewSource.base
  expectedHead = verifiedTerminalReviewSource.head
}
if (pullRequestNumber === 0) {
  if (!/^[0-9a-f]{40}$/.test(expectedHead)) throw new Error('PR_NUMBER=0 requires an exact HEAD_SHA')
  const candidates = await ghJson([
    'pr', 'list', '--repo', repository, '--state', 'open',
    '--json', 'number,headRefOid', '--limit', '101',
  ], 'open pull requests for advancement')
  if (candidates.length > 100) throw new Error('Advancement exceeded its bounded 100 pull request snapshot')
  const matches = candidates.filter(candidate => candidate.headRefOid === expectedHead)
  if (matches.length !== 1) {
    process.stdout.write(`Advancement ignored: expected one open pull request at ${expectedHead}, found ${matches.length}.\n`)
    process.exit(0)
  }
  pullRequestNumber = matches[0].number
}

async function readPullRequest() {
  return ghJson(['api', `repos/${repository}/pulls/${pullRequestNumber}`], `pull request #${pullRequestNumber}`)
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

async function readCheckResults(head) {
  const checkPages = await ghJson([
    'api', `repos/${repository}/commits/${head}/check-runs`, '--paginate', '--slurp',
  ], `check runs for ${head}`)
  const status = await ghJson(['api', `repos/${repository}/commits/${head}/status`], `commit status for ${head}`)
  const contexts = (status?.statuses || []).map(entry => ({
    ...entry,
    __typename: 'StatusContext',
    context: entry.context,
    state: entry.state,
    head_sha: head,
  }))
  return [...checkPages.flatMap(page => page.check_runs || []), ...contexts]
}

async function readGovernorRecords(number) {
  const comments = (await ghJson([
    'api', `repos/${repository}/issues/${number}/comments?per_page=100`, '--paginate', '--slurp',
  ], `pull request #${number} governor records`)).flat()
  return trustedGovernorRecords({
    comments,
    trust: {
      repository,
      controllerRepository: trustedReview.controllerRepository,
      workflowPaths: GOVERNOR_WORKFLOW_PATHS,
    },
    loadRun: runId => ghJson(['api', `repos/${repository}/actions/runs/${runId}`], `governor workflow run ${runId}`),
  })
}

async function readRun(runId) {
  return ghJson(['api', `repos/${repository}/actions/runs/${runId}`], `review workflow run ${runId}`)
}

async function persistedWorkflowIdentity(pullRequest) {
  const pullRequestComments = (await ghJson([
    'api', `repos/${repository}/issues/${pullRequest.number}/comments?per_page=100`, '--paginate', '--slurp',
  ], `pull request #${pullRequest.number} Worker comments`)).flat()
  for (const comment of pullRequestComments.slice().reverse()) {
    const identity = await trustedWorkerIdentity(comment,
      { type: 'pull-request', number: pullRequest.number }, 'repair-worker', repository, readRun, trustedControllerLogin)
    if (identity?.branch === pullRequest.head.ref) return identity
  }
  const references = await ghJson([
    'pr', 'view', String(pullRequest.number), '--repo', repository, '--json', 'closingIssuesReferences',
  ], `pull request #${pullRequest.number} closing Issues`)
  for (const reference of references.closingIssuesReferences || []) {
    if (!Number.isSafeInteger(reference?.number)) continue
    const comments = (await ghJson([
      'api', `repos/${repository}/issues/${reference.number}/comments?per_page=100`, '--paginate', '--slurp',
    ], `Issue #${reference.number} Worker comments`)).flat()
    for (const comment of comments.slice().reverse()) {
      const identity = await trustedWorkerIdentity(comment,
        { type: 'issue', number: reference.number }, 'change-worker', repository, readRun, trustedControllerLogin)
      if (identity?.branch === pullRequest.head.ref) return identity
    }
  }
  return null
}

async function readJobs(runId, runAttempt) {
  const endpoints = reviewFaultAttemptEndpoints(repository, runId, runAttempt)
  const attempt = await ghJson(['api', endpoints.run], `review workflow run ${runId} attempt ${runAttempt}`)
  verifyReviewFaultAttempt(attempt, runId, runAttempt)
  const response = await ghJson(['api', `${endpoints.jobs}?per_page=100`], `review jobs for run ${runId} attempt ${runAttempt}`)
  if (!Array.isArray(response?.jobs) || response.total_count > response.jobs.length) {
    throw new Error('Review job snapshot is incomplete')
  }
  return response.jobs
}

async function reviewConfiguration(pullRequest, checkResults) {
  const candidates = checkResults
    .filter(check => check?.name === 'agent/review' && check.head_sha === pullRequest.head.sha)
    .sort((left, right) => Number(right.id || 0) - Number(left.id || 0))
  for (const check of candidates) {
    const identity = parseReviewCheckIdentity(check)
    if (!identity) continue
    try {
      const run = await readRun(identity.runId)
      if (!hasTrustedExactReviewInvocation({
        pullRequest: {
          number: pullRequest.number,
          repository,
          state: pullRequest.state.toUpperCase(),
          isDraft: Boolean(pullRequest.draft),
          baseRefName: pullRequest.base.ref,
          baseRefOid: pullRequest.base.sha,
          headRefOid: pullRequest.head.sha,
          mergeStateStatus: 'UNKNOWN',
          mergeable: null,
        },
        reviewProof: { checkRun: check, run },
        trustedReview,
      })) continue
      const profile = trustedReviewRunProfile(run, {
        repository,
        controllerRepository: trustedReview.controllerRepository,
        controllerSha: trustedReview.controllerSha,
        workflowPath: trustedReview.workflowPath,
        number: pullRequest.number,
        base: pullRequest.base.sha,
        head: pullRequest.head.sha,
      })
      return { profileId: profile.profileId, workflowId: identity.workflowId }
    } catch {
      // An untrusted or stale same-name review cannot choose the Profile.
    }
  }
  return null
}

function configuredRequiredChecks(names) {
  return names.map(required => {
    const context = typeof required === 'string' ? required : required.context
    const app_id = typeof required === 'string' ? 15368 : required.app_id
    if (!Number.isSafeInteger(app_id) || app_id < 1) {
      throw new Error(`Required check ${context} is not bound to a trusted provider`)
    }
    return { context, app_id }
  })
}

const pullRequest = await readPullRequest()
const checkResults = await readCheckResults(pullRequest.head.sha)
const persistedIdentity = await persistedWorkflowIdentity(pullRequest)
if (persistedIdentity) {
  if (requestedProfileId && requestedProfileId !== 'github-pr-cycle'
    && requestedProfileId !== persistedIdentity.profileId) {
    throw new Error('Worker status Profile does not match the requested Profile')
  }
  profileId = persistedIdentity.profileId
  requestedWorkflowId = persistedIdentity.workflowId
}
const discoveredReview = await reviewConfiguration(pullRequest, checkResults)
if (discoveredReview) {
  if (requestedProfileId && requestedProfileId !== 'github-pr-cycle' && requestedProfileId !== discoveredReview.profileId) {
    throw new Error('Review CheckRun Profile does not match the requested Profile')
  }
  if (requestedWorkflowId && requestedWorkflowId !== discoveredReview.workflowId) {
    throw new Error('Review CheckRun workflow does not match the requested workflow')
  }
  profileId = discoveredReview.profileId
  requestedWorkflowId = discoveredReview.workflowId
}
if (!profileId) profileId = 'github-pr-cycle'
const [profile, governorRecords] = await Promise.all([
  targetProfile(pullRequest.base.sha),
  readGovernorRecords(pullRequest.number),
])
if (persistedIdentity && profile.definitionHash !== persistedIdentity.definitionHash) {
  throw new Error('Worker status Profile hash does not match the trusted target base')
}
const requiredCheckDefinitions = configuredRequiredChecks(requiredChecks)
if (verifiedTerminalReviewSource) {
  const sourceChecks = checkResults.filter(check => check.head_sha === expectedHead
    && parseReviewCheckIdentity(check)?.runId === sourceRunId
    && parseReviewCheckIdentity(check)?.runAttempt === sourceRunAttempt)
  if (sourceChecks.length !== 1) {
    throw new Error('Completed source review workflow does not expose one exact-head controller CheckRun')
  }
  requestedWorkflowId = parseReviewCheckIdentity(sourceChecks[0]).workflowId
}
const snapshot = await buildPullRequestAdvancementSnapshot({
  repository,
  pullRequest,
  defaultBranch,
  expectedPair: { base: expectedBase, head: expectedHead },
  profile,
  requestedWorkflowId,
  trustedReview,
  requiredChecks: requiredCheckDefinitions,
  checkResults,
  governorRecords,
  readRun,
  readJobs,
})
const policyDecision = decidePullRequestAdvancement(snapshot)
const request = {
  ...policyDecision,
  repository,
  pullRequestNumber: pullRequest.number,
  profileId,
}

if (request.action === 'request-repair' && !request.repair?.candidate) {
  const seedIdentity = advancementTransitionIdentity(request)
  const repair = advancementRepairCandidate({
    records: governorRecords,
    subject: pullRequestGovernorSubject(pullRequest),
    stateVersion: request.stateVersion,
    transitionIdentity: seedIdentity,
    repairCause: request.repair?.cause,
  })
  if (!repair.record) throw new Error('Advancement repair candidate disappeared before dispatch')
  await writeGovernorRecord(repair.record)
  request.repair = {
    ...request.repair,
    candidate: { transition: repair.transition, observationId: repair.record.observationId },
  }
}

async function writeGovernorRecord(record) {
  const body = attestedGovernorRecordBody(record, {
    repository,
    controllerRepository: trustedReview.controllerRepository,
    controllerSha: trustedReview.controllerSha,
    workflowPath: governorWorkflowPath,
    runId,
  })
  await run(githubExecutable, [
    'api', '--method', 'POST', `repos/${repository}/issues/${pullRequest.number}/comments`, '--input', '-',
  ], { env: environment, input: JSON.stringify({ body }) })
  governorRecords.push(record)
}

const result = await consumePullRequestAdvancement(request, {
  requestReview: async value => {
    const reviewWorkRequest = {
      requestId: `review-pr-${pullRequest.number}-${snapshot.pair.base}-${snapshot.pair.head}`,
      role: 'review',
    }
    const routingExecution = createWorkerRoutingExecution({
      routingAttemptId: value.transitionIdentity,
      workRequest: reviewWorkRequest,
      subjectStateVersion: request.stateVersion,
      routingPolicy,
      trustedTaskSnapshot: {
        title: pullRequest.title,
        labels: pullRequest.labels,
        workflowStage: snapshot.workflow.stageId,
      },
    })
    await dispatchWithReceipt({
      executable: githubExecutable, environment, repository, workflowFile: 'agent-pr-review.yml',
      payload: {
        event_type: 'agent-review',
        client_payload: {
          pull_request_number: pullRequest.number,
          base_sha: snapshot.pair.base,
          head_sha: snapshot.pair.head,
          profile_id: profileId,
          workflow_id: snapshot.workflow.workflowId,
          stage_id: snapshot.workflow.stageId,
          request_id: value.transitionIdentity,
          worker_routing_execution: routingExecution,
        },
      },
      requestId: value.transitionIdentity,
    })
  },
  requestRepair: async value => {
    const routingExecution = createWorkerRoutingExecution({
      routingAttemptId: value.transitionIdentity,
      workRequest: { requestId: value.transitionIdentity, role: 'change' },
      subjectStateVersion: request.stateVersion,
      routingPolicy,
      trustedTaskSnapshot: {
        title: pullRequest.title,
        labels: pullRequest.labels,
        workflowStage: 'change',
        failureEvidence: { class: value.repair?.cause || 'repair' },
      },
    })
    await dispatchWithReceipt({
      executable: githubExecutable, environment, repository, workflowFile: 'agent-pr-rework.yml',
      payload: {
        event_type: 'agent-review-reconcile',
        client_payload: {
          pull_request_number: pullRequest.number,
          base_sha: snapshot.pair.base,
          head_sha: snapshot.pair.head,
          profile_id: profileId,
          workflow_id: snapshot.workflow.workflowId,
          request_id: value.transitionIdentity,
          repair_cause: value.repair?.cause || '',
          worker_routing_execution: routingExecution,
        },
      },
      requestId: value.transitionIdentity,
    })
  },
  requestLanding: async () => {
    const landing = await run(process.execPath, [landScript], {
      env: {
        ...process.env,
        PR_NUMBER: String(pullRequest.number),
        HEAD_SHA: snapshot.pair.head,
      },
      tee: true,
    })
    return landingResult(landing.stdout)
  },
}, {
  claim: async value => {
    const transition = `pull-request-advancement:${value.transitionIdentity}`
    const matching = record => record.transition === transition
      && record.stateVersion === value.stateVersion
      && record.subject?.type === 'pull-request'
      && record.subject.number === pullRequest.number
    if (governorRecords.some(record => record.status === 'applied' && matching(record))) return false
    if (governorRecords.some(record => record.status === 'candidate' && matching(record))) return true
    await writeGovernorRecord({
      version: 1,
      status: 'candidate',
      transition,
      subject: { type: 'pull-request', number: pullRequest.number },
      stateVersion: value.stateVersion,
      observationId: `run-${runId}`,
    })
    return true
  },
  markInflight: async value => {
    await writeGovernorRecord({
      version: 1,
      status: 'candidate',
      transition: `pull-request-advancement:${value.transitionIdentity}:inflight`,
      subject: { type: 'pull-request', number: pullRequest.number },
      stateVersion: value.stateVersion,
      observationId: `run-${runId}`,
    })
  },
  markApplied: async value => {
    await writeGovernorRecord({
      version: 1,
      status: 'applied',
      transition: `pull-request-advancement:${value.transitionIdentity}`,
      subject: { type: 'pull-request', number: pullRequest.number },
      stateVersion: value.stateVersion,
      observationId: `run-${runId}`,
    })
  },
})
process.stdout.write(`Advancement ${result.action} for pull request #${pullRequest.number} at ${snapshot.pair.base}..${snapshot.pair.head} (${result.transitionIdentity}).\n`)
