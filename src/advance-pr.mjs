import { fileURLToPath } from 'node:url'
import { actionsCredentialEnvironment, parseJson, requiredEnv, run } from './common.mjs'
import { decidePullRequestAdvancement } from './advancement-policy.mjs'
import { buildPullRequestAdvancementSnapshot } from './advancement-state.mjs'
import { consumePullRequestAdvancement } from './advancement-runtime.mjs'
import { loadTrustedWorkflowProfile } from './workflow-profile.mjs'
import {
  attestedGovernorRecordBody,
  GOVERNOR_WORKFLOW_PATHS,
  trustedGovernorRecords,
} from './governor-state.mjs'
import { reviewFaultAttemptEndpoints, verifyReviewFaultAttempt } from './review-fault-audit.mjs'

const repository = requiredEnv('TARGET_REPOSITORY')
const requestedNumber = Number.parseInt(process.env.PR_NUMBER || '0', 10)
const expectedBase = process.env.BASE_SHA?.trim().toLowerCase() || ''
const expectedHead = process.env.HEAD_SHA?.trim().toLowerCase() || ''
const defaultBranch = requiredEnv('DEFAULT_BRANCH')
const profileId = process.env.PROFILE_ID?.trim() || 'github-pr-cycle'
const requestedWorkflowId = process.env.WORKFLOW_ID?.trim() || ''
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

if (!Number.isSafeInteger(requestedNumber) || requestedNumber < 0) throw new Error('Invalid PR_NUMBER')
if (!Number.isSafeInteger(runId) || runId < 1 || !GOVERNOR_WORKFLOW_PATHS.includes(governorWorkflowPath)) {
  throw new Error('Advancement Governor writer provenance is invalid')
}
if (!Array.isArray(requiredChecks) || requiredChecks.length < 1 || requiredChecks.length > 32
  || requiredChecks.some(name => typeof name !== 'string' || !name.trim() || name === 'agent/review')) {
  throw new Error('REQUIRED_CHECKS_JSON must contain configured non-review check names')
}

async function ghJson(args, description) {
  const result = await run(githubExecutable, args, { env: environment })
  return parseJson(result.stdout, description)
}

let pullRequestNumber = requestedNumber
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

const pullRequest = await readPullRequest()
const [profile, checkResults, governorRecords] = await Promise.all([
  targetProfile(pullRequest.base.sha),
  readCheckResults(pullRequest.head.sha),
  readGovernorRecords(pullRequest.number),
])
const snapshot = await buildPullRequestAdvancementSnapshot({
  repository,
  pullRequest,
  defaultBranch,
  expectedPair: { base: expectedBase, head: expectedHead },
  profile,
  requestedWorkflowId,
  trustedReview,
  requiredChecks,
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

const result = await consumePullRequestAdvancement(request, {
  requestReview: async value => {
    await run(githubExecutable, [
      'api', '--method', 'POST', `repos/${repository}/dispatches`, '--input', '-',
    ], {
      env: environment,
      input: JSON.stringify({
        event_type: 'agent-review',
        client_payload: {
          pull_request_number: pullRequest.number,
          base_sha: snapshot.pair.base,
          head_sha: snapshot.pair.head,
          profile_id: profileId,
          workflow_id: snapshot.workflow.workflowId,
          stage_id: snapshot.workflow.stageId,
          request_id: value.transitionIdentity,
        },
      }),
    })
  },
  requestRepair: async value => {
    await run(githubExecutable, [
      'api', '--method', 'POST', `repos/${repository}/dispatches`, '--input', '-',
    ], {
      env: environment,
      input: JSON.stringify({
        event_type: 'agent-review-reconcile',
        client_payload: {
          pull_request_number: pullRequest.number,
          base_sha: snapshot.pair.base,
          head_sha: snapshot.pair.head,
          request_id: value.transitionIdentity,
        },
      }),
    })
  },
  requestLanding: async () => {
    await run(process.execPath, [landScript], {
      env: {
        ...process.env,
        PR_NUMBER: String(pullRequest.number),
        HEAD_SHA: snapshot.pair.head,
      },
      tee: true,
    })
  },
}, {
  isApplied: value => governorRecords.some(record => record.status === 'applied'
    && record.transition === `pull-request-advancement:${value.transitionIdentity}`
    && record.stateVersion === value.stateVersion
    && record.subject?.type === 'pull-request'
    && record.subject.number === pullRequest.number),
  markApplied: async value => {
    const body = attestedGovernorRecordBody({
      version: 1,
      status: 'applied',
      transition: `pull-request-advancement:${value.transitionIdentity}`,
      subject: { type: 'pull-request', number: pullRequest.number },
      stateVersion: value.stateVersion,
      observationId: `run-${runId}`,
    }, {
      repository,
      controllerRepository: trustedReview.controllerRepository,
      controllerSha: trustedReview.controllerSha,
      workflowPath: governorWorkflowPath,
      runId,
    })
    await run(githubExecutable, [
      'api', '--method', 'POST', `repos/${repository}/issues/${pullRequest.number}/comments`, '--input', '-',
    ], { env: environment, input: JSON.stringify({ body }) })
  },
})
process.stdout.write(`Advancement ${result.action} for pull request #${pullRequest.number} at ${snapshot.pair.base}..${snapshot.pair.head} (${result.transitionIdentity}).\n`)
