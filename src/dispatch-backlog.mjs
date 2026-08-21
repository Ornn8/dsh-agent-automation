import {
  actionsCredentialEnvironment,
  parseJson,
  requiredEnv,
  run,
} from './common.mjs'
import {
  activeWorkflowIssueNumbers,
  independentIssueObservationNumber,
  selectBacklogWork,
  trustedBlockedReviewProof,
} from './dispatch-policy.mjs'
import { reviewRunIdFromCheckRun } from './landing-policy.mjs'
import {
  governorBudgetDecision,
  governorDecision,
  subjectStateVersion,
  workflowStageTransition,
} from './governor-policy.mjs'
import {
  attestedGovernorRecordBody,
  GOVERNOR_WORKFLOW_PATHS,
  issueGovernorSubject,
  pullRequestGovernorSubject,
  trustedGovernorRecords,
} from './governor-state.mjs'
import { agentWorkRequestId } from './agent-work.mjs'
import { loadTrustedWorkflowProfile, resolveWorkflow } from './workflow-profile.mjs'
import { createIssueImplementationRequest, repositoryDispatchBody } from './work-request.mjs'
import { createWorkerRoutingExecution } from './worker-routing.mjs'

const repository = requiredEnv('TARGET_REPOSITORY')
const githubExecutable = process.env.GH_EXECUTABLE?.trim() || 'gh'
const githubEnvironment = actionsCredentialEnvironment()
const trustedReview = {
  controllerRepository: requiredEnv('TRUSTED_CONTROLLER_REPOSITORY'),
  controllerSha: requiredEnv('TRUSTED_CONTROLLER_SHA'),
  workflowPath: requiredEnv('TRUSTED_REVIEW_WORKFLOW_PATH'),
}
const governorTrust = {
  repository,
  controllerRepository: trustedReview.controllerRepository,
  workflowPaths: GOVERNOR_WORKFLOW_PATHS,
}
const governorWriterTrust = {
  repository,
  controllerRepository: trustedReview.controllerRepository,
  controllerSha: trustedReview.controllerSha.toLowerCase(),
  workflowPath: '.github/workflows/dispatch-backlog.yml',
}
const observationId = `${requiredEnv('GITHUB_RUN_ID')}:${process.env.GITHUB_RUN_ATTEMPT || '1'}`
const routingPolicy = process.env.WORKER_ROUTING_POLICY_JSON?.trim()
  ? parseJson(process.env.WORKER_ROUTING_POLICY_JSON, 'worker routing policy')
  : { version: 1, defaultRoute: 'default', routes: { default: {} } }
const requestedIssueNumber = (() => {
  const value = process.env.REQUESTED_ISSUE_NUMBER?.trim() || '0'
  if (!/^\d+$/.test(value)) throw new Error('REQUESTED_ISSUE_NUMBER must be a non-negative integer')
  const number = Number.parseInt(value, 10)
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new Error('REQUESTED_ISSUE_NUMBER must be a non-negative safe integer')
  }
  return number === 0 ? null : number
})()

if (!/^[0-9a-f]{40}$/i.test(trustedReview.controllerSha)) {
  throw new Error('TRUSTED_CONTROLLER_SHA must be a full commit SHA')
}

async function ghJson(args, description) {
  const result = await run(githubExecutable, args, { env: githubEnvironment })
  return parseJson(result.stdout, description)
}

async function ghPages(path, description) {
  const pages = await ghJson(['api', path, '--paginate', '--slurp'], description)
  return pages.flat()
}

async function trustedBlockedRepairNumbers(pullRequests) {
  const result = new Set()
  for (const candidate of pullRequests) {
    if (candidate.draft || candidate.head?.repo?.full_name !== repository
      || !candidate.labels?.some(label => label.name === 'automation/review-blocked')) continue
    const pullRequest = {
      number: candidate.number,
      repository,
      state: candidate.state?.toUpperCase(),
      isDraft: candidate.draft,
      baseRefName: candidate.base?.ref,
      baseRefOid: candidate.base?.sha,
      headRefOid: candidate.head?.sha,
    }
    if (typeof pullRequest.baseRefOid !== 'string' || typeof pullRequest.headRefOid !== 'string') continue
    const pages = await ghJson([
      'api', `repos/${repository}/commits/${pullRequest.headRefOid}/check-runs`, '--paginate', '--slurp',
    ], `check runs for pull request #${pullRequest.number}`)
    for (const checkRun of pages.flatMap(page => page.check_runs || [])) {
      if (checkRun.name !== 'agent/review') continue
      const runId = reviewRunIdFromCheckRun(checkRun, repository)
      if (!runId) continue
      const workflowRun = await ghJson([
        'api', `repos/${repository}/actions/runs/${runId}`,
      ], `review workflow run ${runId}`)
      if (trustedBlockedReviewProof({
        pullRequest,
        reviewProof: { checkRun, run: workflowRun },
        trustedReview,
      })) {
        result.add(pullRequest.number)
        break
      }
    }
  }
  return result
}

async function targetProfile(profileId, revision) {
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

async function governorComments(number) {
  return ghPages(`repos/${repository}/issues/${number}/comments?per_page=100`, `governor comments for #${number}`)
}

async function governorRecords(number) {
  return trustedGovernorRecords({
    comments: await governorComments(number),
    trust: governorTrust,
    loadRun: runId => ghJson(['api', `repos/${repository}/actions/runs/${runId}`], `governor workflow run ${runId}`),
  })
}

async function writeGovernorRecord(number, record) {
  await run(githubExecutable, [
    'api', '--method', 'POST', `repos/${repository}/issues/${number}/comments`, '--input', '-',
  ], {
    env: githubEnvironment,
    input: JSON.stringify({
      body: attestedGovernorRecordBody(record, {
        ...governorWriterTrust,
        runId: Number.parseInt(requiredEnv('GITHUB_RUN_ID'), 10),
      }),
    }),
  })
}

async function requestIndependentIssueObservation(number) {
  await run(githubExecutable, [
    'api', '--method', 'POST', `repos/${repository}/dispatches`, '--input', '-',
  ], {
    env: githubEnvironment,
    input: JSON.stringify({
      event_type: 'agent_backlog_reconcile',
      client_payload: { issue_number: number },
    }),
  })
}

async function admittedWork(work, pullRequests, issues) {
  const source = work.type === 'repair'
    ? pullRequests.find(candidate => candidate.number === work.number)
    : issues.find(candidate => candidate.number === work.number)
  if (!source) throw new Error(`Governor subject #${work.number} is missing from the bounded snapshot`)
  const subject = work.type === 'repair'
    ? pullRequestGovernorSubject(source)
    : issueGovernorSubject(source)
  const transition = work.request
    ? workflowStageTransition(work.request)
    : 'review-repair'
  const stateVersion = subjectStateVersion(subject)
  const records = await governorRecords(work.number)
  const decision = governorDecision({ transition, subject, stateVersion, observationId, records })
  if (decision.record) await writeGovernorRecord(work.number, decision.record)
  if (!decision.execute) {
    const observationNumber = independentIssueObservationNumber({
      work,
      governorAction: decision.action,
    })
    if (observationNumber !== null) {
      await requestIndependentIssueObservation(observationNumber)
      process.stdout.write(`Requested an independent backlog observation for Issue #${observationNumber}.\n`)
    }
    process.stdout.write(`Governor ${decision.action} for ${subject.type} #${work.number}; no work was dispatched.\n`)
    return null
  }
  if (work.type === 'repair') {
    const budget = governorBudgetDecision({
      transition,
      subject: { type: subject.type, number: subject.number },
      workIdentity: `branch:${source.head.ref}`,
      observationId,
      limit: 6,
      records,
    })
    if (budget.record) await writeGovernorRecord(work.number, budget.record)
    if (!budget.execute) {
      if (budget.action !== 'pause') {
        process.stdout.write(`Governor ${budget.action} for pull request #${work.number}; no work was dispatched.\n`)
        return null
      }
      await run(githubExecutable, [
        'label', 'create', 'automation/paused', '--repo', repository,
        '--description', 'Automatic governor budget exhausted', '--color', 'D93F0B',
      ], { env: githubEnvironment }).catch(() => undefined)
      await run(githubExecutable, [
        'pr', 'edit', String(work.number), '--repo', repository,
        '--add-label', 'automation/paused', '--remove-label', 'automation/review-blocked',
      ], { env: githubEnvironment })
      process.stdout.write(`Governor paused pull request #${work.number} after its review-repair budget was exhausted.\n`)
      return null
    }
  }
  return { subject, stateVersion, transition }
}

async function recordApplied(work, admission) {
  await writeGovernorRecord(work.number, {
    version: 1,
    status: 'applied',
    transition: admission.transition,
    subject: { type: admission.subject.type, number: admission.subject.number },
    stateVersion: admission.stateVersion,
    observationId,
  })
}

const pullRequests = await ghPages(`repos/${repository}/pulls?state=open&per_page=100`, 'open pull requests')
const issues = (await ghPages(`repos/${repository}/issues?state=all&per_page=100`, 'Issues'))
  .filter(issue => !issue.pull_request)
const work = selectBacklogWork({
  repository,
  pullRequests,
  issues,
  trustedBlockedRepairNumbers: await trustedBlockedRepairNumbers(pullRequests),
  includeRepairs: false,
  requestedIssueNumber,
})

if (!work) {
  process.stdout.write('No eligible DSH backlog work is ready.\n')
  process.exit(0)
}

if (work.type === 'issue') {
  const repositoryState = await ghJson(['api', `repos/${repository}`], 'repository state')
  const defaultBranch = repositoryState.default_branch
  if (typeof defaultBranch !== 'string' || !defaultBranch) throw new Error('Repository default branch is missing')
  const baseCommit = await ghJson([
    'api', `repos/${repository}/commits/${encodeURIComponent(defaultBranch)}`,
  ], `default branch ${defaultBranch}`)
  if (!/^[0-9a-f]{40}$/.test(baseCommit?.sha || '')) throw new Error('Default branch head is not a full SHA')
  const profile = await targetProfile(work.work.profile, baseCommit.sha)
  const workflow = resolveWorkflow(profile.definition, work.work.workflow)
  const active = activeWorkflowIssueNumbers({
    issues,
    pullRequests,
    profileId: profile.definition.profileId,
    workflowId: work.work.workflow,
    excludeIssueNumber: requestedIssueNumber === work.number ? work.number : null,
  })
  if (active.size >= workflow.coordination.limit) {
    process.stdout.write(`Workflow ${profile.definition.profileId}/${work.work.workflow} is at its coordination limit ${workflow.coordination.limit}.\n`)
    process.exit(0)
  }
  const requestId = agentWorkRequestId(work.work, profile.definitionHash)
  work.request = createIssueImplementationRequest({
    ...profile,
    workflowId: work.work.workflow,
    repository,
    issueNumber: work.number,
    base: baseCommit.sha,
    requestId,
  })
}

const admission = await admittedWork(work, pullRequests, issues)
if (!admission) process.exit(0)
const admittedSource = work.type === 'repair'
  ? pullRequests.find(candidate => candidate.number === work.number)
  : issues.find(candidate => candidate.number === work.number)
if (!admittedSource) throw new Error(`Governor subject #${work.number} disappeared before dispatch`)

if (work.type === 'repair') {
  await recordApplied(work, admission)
  const routingExecution = createWorkerRoutingExecution({
    routingAttemptId: `repair-${work.number}-${work.head}`,
    workRequest: { requestId: 'backlog', role: 'change' },
    subjectStateVersion: admission.stateVersion,
    routingPolicy,
    trustedTaskSnapshot: {
      title: admittedSource.title,
      body: admittedSource.body,
      labels: admittedSource.labels,
      workflowStage: 'change',
      failureEvidence: { class: 'repair' },
    },
  })
  await run(githubExecutable, [
    'api', '--method', 'POST', `repos/${repository}/dispatches`, '--input', '-',
  ], {
    env: githubEnvironment,
    input: JSON.stringify({
      event_type: 'dsh-repair',
      client_payload: {
        pr_number: work.number,
        head_sha: work.head,
        request_id: 'backlog',
        worker_routing_execution: routingExecution,
      },
    }),
  })
  process.stdout.write(`Dispatched blocked pull request #${work.number} at ${work.head}.\n`)
} else {
  await run(githubExecutable, [
    'issue', 'edit', String(work.number), '--repo', repository, '--add-label', 'agent/dsh',
  ], { env: githubEnvironment })
  try {
    await run(githubExecutable, [
      'api', '--method', 'POST', `repos/${repository}/dispatches`, '--input', '-',
    ], { env: githubEnvironment, input: JSON.stringify(repositoryDispatchBody(work.request, {
      routingAttemptId: work.request.requestId,
      subjectStateVersion: admission.stateVersion,
      routingPolicy,
      trustedTaskSnapshot: {
        title: admittedSource.title,
        body: admittedSource.body,
        labels: admittedSource.labels,
        workflowStage: work.request.stageId,
      },
    })) })
  } catch (error) {
    await run(githubExecutable, [
      'issue', 'edit', String(work.number), '--repo', repository, '--remove-label', 'agent/dsh',
    ], { env: githubEnvironment }).catch(() => undefined)
    throw error
  }
  await recordApplied(work, admission)
  process.stdout.write(`Dispatched Issue #${work.number} as ${work.request.profileId}/${work.request.workflowId}/${work.request.stageId}.\n`)
}
