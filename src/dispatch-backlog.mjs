import {
  actionsCredentialEnvironment,
  parseJson,
  requiredEnv,
  run,
  trustedAssociation,
} from './common.mjs'
import {
  activeWorkflowIssueNumbers,
  independentIssueObservationNumber,
  selectBacklogBatch,
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
import { agentWorkRequestId, parseAgentWork } from './agent-work.mjs'
import {
  parseMaximumBatchSize,
  runBacklogBatch,
  selectBacklogDispatches,
} from './dispatch-backlog-helper.mjs'
import { loadTrustedWorkflowProfile, resolveWorkflow } from './workflow-profile.mjs'
import { createIssueImplementationRequest, repositoryDispatchBody } from './work-request.mjs'

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
const requestedIssueNumber = (() => {
  const value = process.env.REQUESTED_ISSUE_NUMBER?.trim() || '0'
  if (!/^\d+$/.test(value)) throw new Error('REQUESTED_ISSUE_NUMBER must be a non-negative integer')
  const number = Number.parseInt(value, 10)
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new Error('REQUESTED_ISSUE_NUMBER must be a non-negative safe integer')
  }
  return number === 0 ? null : number
})()
const maximumBatchSize = parseMaximumBatchSize(process.env.MAXIMUM_BATCH_SIZE)

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

async function batchWorkflowLimits({ issues, revision, profileCache }) {
  const limits = {}
  for (const issue of issues) {
    if (issue.state !== 'open' || !trustedAssociation(issue.author_association)) continue
    let work
    try { work = parseAgentWork(issue.body) } catch { continue }
    if (!work || work.dispatch !== 'ready') continue
    if (!profileCache.has(work.profile)) {
      try { profileCache.set(work.profile, await targetProfile(work.profile, revision)) } catch { profileCache.set(work.profile, null) }
    }
    const profile = profileCache.get(work.profile)
    if (!profile) continue
    try {
      const workflow = resolveWorkflow(profile.definition, work.workflow)
      limits[`${work.profile}/${work.workflow}`] = workflow.coordination.limit
    } catch {
      // The batch policy excludes declarations whose trusted Workflow is unavailable.
    }
  }
  return limits
}

async function defaultBranchCommit() {
  const repositoryState = await ghJson(['api', `repos/${repository}`], 'repository state')
  const defaultBranch = repositoryState.default_branch
  if (typeof defaultBranch !== 'string' || !defaultBranch) throw new Error('Repository default branch is missing')
  const baseCommit = await ghJson([
    'api', `repos/${repository}/commits/${encodeURIComponent(defaultBranch)}`,
  ], `default branch ${defaultBranch}`)
  if (!/^[0-9a-f]{40}$/.test(baseCommit?.sha || '')) throw new Error('Default branch head is not a full SHA')
  return baseCommit
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

async function dispatchIssueSelection(work, profile, baseCommit, pullRequests, issues) {
  const requestId = agentWorkRequestId(work.work, profile.definitionHash, profile.verificationContract?.hash)
  work.request = createIssueImplementationRequest({
    ...profile,
    workflowId: work.work.workflow,
    repository,
    issueNumber: work.number,
    base: baseCommit.sha,
    requestId,
  })
  const admission = await admittedWork(work, pullRequests, issues)
  if (!admission) return { status: 'observed' }

  await run(githubExecutable, [
    'label', 'create', 'agent/dsh', '--repo', repository,
    '--description', 'A ready Issue is queued for DSH execution', '--color', '1D76DB', '--force',
  ], { env: githubEnvironment })
  await run(githubExecutable, [
    'issue', 'edit', String(work.number), '--repo', repository, '--add-label', 'agent/dsh',
  ], { env: githubEnvironment })
  try {
    await run(githubExecutable, [
      'api', '--method', 'POST', `repos/${repository}/dispatches`, '--input', '-',
    ], { env: githubEnvironment, input: JSON.stringify(repositoryDispatchBody(work.request)) })
  } catch (error) {
    await run(githubExecutable, [
      'issue', 'edit', String(work.number), '--repo', repository, '--remove-label', 'agent/dsh',
    ], { env: githubEnvironment }).catch(() => undefined)
    throw error
  }
  await recordApplied(work, admission)
  process.stdout.write(`Dispatched Issue #${work.number} as ${work.request.profileId}/${work.request.workflowId}/${work.request.stageId}.\n`)
  return { status: 'applied' }
}

const pullRequests = await ghPages(`repos/${repository}/pulls?state=open&per_page=100`, 'open pull requests')
const issues = (await ghPages(`repos/${repository}/issues?state=all&per_page=100`, 'Issues'))
  .filter(issue => !issue.pull_request)
const trustedBlocked = requestedIssueNumber === null
  ? new Set()
  : await trustedBlockedRepairNumbers(pullRequests)
const selectionDiagnostics = []
function reportSelectionDiagnostics() {
  if (selectionDiagnostics.length > 0) {
    process.stdout.write(`Backlog dependency diagnostics: ${JSON.stringify(selectionDiagnostics.slice(0, 64))}\n`)
  }
}
const singleSelections = requestedIssueNumber === null ? [] : selectBacklogDispatches({
  requestedIssueNumber,
  selectSingle: () => selectBacklogWork({
    repository,
    pullRequests,
    issues,
    trustedBlockedRepairNumbers: trustedBlocked,
    includeRepairs: false,
    requestedIssueNumber,
    diagnostics: selectionDiagnostics,
  }),
  selectBatch: () => [],
})

if (requestedIssueNumber !== null) {
  const work = singleSelections[0]
  reportSelectionDiagnostics()
  if (!work) {
    process.stdout.write('No eligible DSH backlog work is ready.\n')
    process.exit(0)
  }
  const baseCommit = await defaultBranchCommit()
  const profile = await targetProfile(work.work.profile, baseCommit.sha)
  const workflow = resolveWorkflow(profile.definition, work.work.workflow)
  const active = activeWorkflowIssueNumbers({
    issues,
    pullRequests,
    profileId: profile.definition.profileId,
    workflowId: work.work.workflow,
    excludeIssueNumber: work.number,
  })
  if (active.size >= workflow.coordination.limit) {
    process.stdout.write(`Workflow ${profile.definition.profileId}/${work.work.workflow} is at its coordination limit ${workflow.coordination.limit}.\n`)
    process.exit(0)
  }
  await dispatchIssueSelection(work, profile, baseCommit, pullRequests, issues)
  process.exit(0)
}

const baseCommit = await defaultBranchCommit()
const profileCache = new Map()
const workflowLimits = await batchWorkflowLimits({
  issues, revision: baseCommit.sha, profileCache,
})
const selections = selectBacklogDispatches({
  selectSingle: () => null,
  selectBatch: () => selectBacklogBatch({
    repository,
    pullRequests,
    issues,
    workflowLimits,
    maximumBatchSize,
    diagnostics: selectionDiagnostics,
  }),
})
reportSelectionDiagnostics()
if (!selections.length) {
  process.stdout.write('No eligible DSH backlog work is ready.\n')
  process.exit(0)
}

try {
  await runBacklogBatch(selections, selection => dispatchIssueSelection(
    selection,
    profileCache.get(selection.work.profile),
    baseCommit,
    pullRequests,
    issues,
  ))
} catch (error) {
  process.stderr.write(`${error.message}\n`)
  process.exitCode = 1
}
