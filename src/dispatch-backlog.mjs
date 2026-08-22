import {
  actionsCredentialEnvironment,
  parseJson,
  requiredEnv,
  run,
} from './common.mjs'
import { appendFile } from 'node:fs/promises'
import {
  activeWorkflowIssueNumbers,
  independentIssueObservationNumber,
  selectBacklogWork,
  selectCapacityWaitingWork,
  trustedBlockedReviewProof,
} from './dispatch-policy.mjs'
import { capacityResumeRequestId, parseCapacityWaitStatus } from './capacity-wait-projection.mjs'
import { trustedControllerMutation } from './controller-mutation-marker.mjs'
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
import { agentWorkRequestId, resolveAgentWorkDispatch } from './agent-work.mjs'
import { loadTrustedWorkflowProfile, resolveWorkflow, resolveWorkflowStage } from './workflow-profile.mjs'
import { createIssueImplementationRequest, createStageWorkRequest, repositoryDispatchBody } from './work-request.mjs'
import { parseWorkerRouteDecision } from './worker-routing.mjs'

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
const capacityResumeOnly = (() => {
  const value = process.env.CAPACITY_RESUME_ONLY?.trim() || 'false'
  if (value !== 'true' && value !== 'false') throw new Error('CAPACITY_RESUME_ONLY must be true or false')
  return value === 'true'
})()
const capacityRunNumber = (() => {
  if (!capacityResumeOnly) return 1
  const value = process.env.GITHUB_RUN_NUMBER?.trim() || '1'
  if (!/^[1-9][0-9]*$/.test(value)) throw new Error('GITHUB_RUN_NUMBER must be a positive integer')
  const runNumber = Number.parseInt(value, 10)
  if (!Number.isSafeInteger(runNumber) || runNumber < 1) throw new Error('GITHUB_RUN_NUMBER must be a positive safe integer')
  return runNumber
})()
const capacityRotatingPage = capacityResumeOnly ? ((capacityRunNumber - 1) % 16) + 1 : 1
const capacityPageSize = 100
const trustedControllerLogin = capacityResumeOnly ? requiredEnv('TRUSTED_CONTROLLER_LOGIN') : ''
if (capacityResumeOnly && !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(trustedControllerLogin)) {
  throw new Error('TRUSTED_CONTROLLER_LOGIN is invalid')
}

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

const CAPACITY_ISSUE_URL = /^https:\/\/api\.github\.com\/repos\/([^/]+\/[^/]+)\/issues\/([1-9][0-9]*)$/

function capacityCommentReference(comment) {
  const match = CAPACITY_ISSUE_URL.exec(String(comment?.issue_url || ''))
  if (!match || match[1] !== repository) return null
  return Number.parseInt(match[2], 10)
}

async function currentCapacitySubject(projection, number) {
  const endpoint = projection.subject.type === 'pull-request' ? 'pulls' : 'issues'
  const candidate = await ghJson(
    ['api', `repos/${repository}/${endpoint}/${number}`],
    `current capacity subject ${projection.subject.type} #${number}`,
  )
  if (candidate?.number !== number || candidate.state !== 'open') return null
  if (projection.subject.type === 'issue' && candidate.pull_request) return null
  return candidate
}

async function capacityComments() {
  const pages = [1]
  if (capacityRotatingPage > 1) pages.push(capacityRotatingPage)
  const comments = []
  for (const page of pages) {
    const pageComments = await ghJson([
      'api', `repos/${repository}/issues/comments?sort=updated&direction=desc&per_page=${capacityPageSize}&page=${page}`,
    ], `bounded capacity wait comments page ${page}`)
    if (!Array.isArray(pageComments)) throw new Error('Bounded capacity wait comments response is invalid')
    const seenCommentIds = new Set(comments.map(comment => comment?.id).filter(id => Number.isSafeInteger(id)))
    for (const comment of pageComments) {
      if (Number.isSafeInteger(comment?.id) && seenCommentIds.has(comment.id)) continue
      if (Number.isSafeInteger(comment?.id)) seenCommentIds.add(comment.id)
      comments.push(comment)
    }
  }
  return comments
}

async function capacitySnapshot() {
  const comments = await capacityComments()
  const waits = []
  const pullRequests = []
  const issues = []
  const seenNumbers = new Set()
  for (const status of comments.filter(comment => comment?.user?.login === trustedControllerLogin
    && /^- Status: \*\*capacity-waiting\*\*$/m.test(String(comment.body || '')))) {
    const number = capacityCommentReference(status)
    if (number === null || seenNumbers.has(number)) continue
    seenNumbers.add(number)
    let projection
    try {
      projection = parseCapacityWaitStatus(status.body)
    } catch {
      continue
    }
    if (projection.role !== 'change' || projection.subject.number !== number) continue
    let candidate
    try {
      candidate = await currentCapacitySubject(projection, number)
    } catch {
      continue
    }
    if (!candidate || (projection.subject.type === 'pull-request' && candidate.draft)) continue
    const expectedSubject = { type: projection.subject.type, number }
    let mutation
    try {
      mutation = await trustedControllerMutation({
        comment: status,
        expectedControllerLogin: trustedControllerLogin,
        expectedRepository: repository,
        expectedSubject,
        loadRun: runId => ghJson(
          ['api', `repos/${repository}/actions/runs/${runId}`],
          `capacity wait worker run ${runId}`,
        ),
      })
    } catch {
      continue
    }
    if (mutation.operation !== (expectedSubject.type === 'pull-request' ? 'repair-worker' : 'change-worker')) continue
    const subject = expectedSubject.type === 'pull-request'
      ? pullRequestGovernorSubject(candidate)
      : issueGovernorSubject(candidate)
    waits.push({ repository, projection, currentStateVersion: subjectStateVersion(subject) })
    if (expectedSubject.type === 'pull-request') pullRequests.push(candidate)
    else issues.push(candidate)
  }
  return { waits, pullRequests, issues }
}

async function currentDefaultBranchCommit() {
  const repositoryState = await ghJson(['api', `repos/${repository}`], 'repository state for capacity resume')
  if (typeof repositoryState?.default_branch !== 'string' || !repositoryState.default_branch) {
    throw new Error('Repository default branch is missing for capacity resume')
  }
  const commit = await ghJson([
    'api', `repos/${repository}/commits/${encodeURIComponent(repositoryState.default_branch)}`,
  ], `default branch ${repositoryState.default_branch} for capacity resume`)
  if (!/^[0-9a-f]{40}$/.test(commit?.sha || '')) {
    throw new Error('Default branch head is not a full SHA for capacity resume')
  }
  return { name: repositoryState.default_branch, sha: commit.sha }
}

async function currentCapacityWaits(capacity) {
  const defaultBranch = await currentDefaultBranchCommit()
  const profileCache = new Map()
  const currentIssues = new Map(capacity.issues.map(issue => [issue.number, issue]))
  const currentPullRequests = new Map(capacity.pullRequests.map(pullRequest => [pullRequest.number, pullRequest]))
  const waits = []
  for (const wait of capacity.waits) {
    const projection = wait.projection
    if (projection.revision.base !== defaultBranch.sha) continue
    if (projection.subject.type === 'pull-request'
      && currentPullRequests.get(projection.subject.number)?.base?.ref !== defaultBranch.name) continue
    const cacheKey = `${projection.profileId}:${projection.revision.base}`
    try {
      let profile = profileCache.get(cacheKey)
      if (!profile) {
        profile = await targetProfile(projection.profileId, projection.revision.base)
        profileCache.set(cacheKey, profile)
      }
      if (profile.definitionHash !== projection.definitionHash
        || profile.definition.profileId !== projection.profileId) continue
      const stage = resolveWorkflowStage(
        profile.definition,
        projection.workflowId,
        projection.stageId,
        'worker',
      )
      if (stage.role !== projection.role
        || (projection.subject.type === 'pull-request' && stage.procedure !== 'github-pr-repair')) continue
      const request = createStageWorkRequest({
        ...profile,
        workflowId: projection.workflowId,
        stageId: projection.stageId,
        repository,
        subject: { type: projection.subject.type, number: projection.subject.number },
        revision: projection.revision,
        coordinationKey: `${repository}:${profile.definition.profileId}:${projection.workflowId}`,
        requestId: projection.workRequestId,
      })
      if (projection.subject.type === 'issue') {
        const issue = currentIssues.get(projection.subject.number)
        const dispatch = resolveAgentWorkDispatch(
          issue?.body || '',
          projection.subject.number,
          request.requestId,
          profile.definitionHash,
        )
        if (!dispatch || dispatch.work.profile !== projection.profileId
          || dispatch.work.workflow !== projection.workflowId) continue
      }
      parseWorkerRouteDecision(projection.routeDecision, {
        workRequest: request,
        stateVersion: wait.currentStateVersion,
      })
      waits.push({ ...wait, request })
    } catch (error) {
      // One stale subject, Profile, Stage, or route projection must not block another waiter.
    }
  }
  return waits
}

function capacityResumeOutput(work) {
  if (!work || !['issue', 'repair'].includes(work.type) || !work.projection || !work.request) {
    throw new Error('Capacity resume output requires one selected WorkRequest')
  }
  const expectedSubjectType = work.type === 'repair' ? 'pull-request' : 'issue'
  const request = work.request
  const projection = work.projection
  if (work.number !== projection.subject.number
    || request.role !== 'change' || request.repository !== repository
    || request.requestId !== projection.workRequestId
    || request.profileId !== projection.profileId
    || request.workflowId !== projection.workflowId
    || request.stageId !== projection.stageId
    || request.definitionHash !== projection.definitionHash
    || request.coordinationKey !== `${repository}:${projection.profileId}:${projection.workflowId}`
    || request.subject.type !== expectedSubjectType
    || request.subject.number !== projection.subject.number
    || request.revision.base !== projection.revision.base
    || request.revision.head !== projection.revision.head) {
    throw new Error('Capacity resume output WorkRequest does not match its projection')
  }
  const capacityResumeId = capacityResumeRequestId(projection)
  const headSha = work.type === 'repair' ? projection.subject.head : request.revision.head
  if (!/^capacity-resume-[0-9a-f]{64}$/.test(capacityResumeId) || !/^[0-9a-f]{40}$/.test(headSha)) {
    throw new Error('Capacity resume output identity is invalid')
  }
  return {
    version: 1,
    type: work.type,
    work_request: request,
    capacity_resume_id: capacityResumeId,
    pull_request_number: work.type === 'repair' ? work.number : null,
    head_sha: headSha,
  }
}

async function writeCapacityOutputs(output = null) {
  const values = {
    resume_type: output?.type || '',
    work_request: output ? JSON.stringify(output.work_request) : '',
    capacity_resume_id: output?.capacity_resume_id || '',
    pull_request_number: output?.pull_request_number ? String(output.pull_request_number) : '',
    head_sha: output?.head_sha || '',
    resume_json: output ? JSON.stringify(output) : '',
  }
  const outputPath = process.env.GITHUB_OUTPUT?.trim()
  if (outputPath) await appendFile(outputPath, `${Object.entries(values).map(([key, value]) => `${key}=${value}`).join('\n')}\n`)
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

const capacity = capacityResumeOnly ? await capacitySnapshot() : null
const capacityWaits = capacityResumeOnly ? await currentCapacityWaits(capacity) : null
const pullRequests = capacityResumeOnly
  ? capacity.pullRequests
  : await ghPages(`repos/${repository}/pulls?state=open&per_page=${capacityPageSize}`, 'open pull requests')
const issues = capacityResumeOnly
  ? capacity.issues
  : (await ghPages(`repos/${repository}/issues?state=all&per_page=${capacityPageSize}`, 'Issues'))
    .filter(issue => !issue.pull_request)
const work = capacityResumeOnly
  ? selectCapacityWaitingWork({
    pullRequests,
    issues,
    capacityWaits,
    rotation: capacityRunNumber,
  })
  : selectBacklogWork({
    repository,
    pullRequests,
    issues,
    trustedBlockedRepairNumbers: await trustedBlockedRepairNumbers(pullRequests),
    includeRepairs: false,
    requestedIssueNumber,
  })

if (!work) {
  if (capacityResumeOnly) await writeCapacityOutputs()
  process.stdout.write('No eligible DSH backlog work is ready.\n')
  process.exit(0)
}

if (work.type === 'issue') {
  if (capacityResumeOnly) {
    if (!work.request) throw new Error('Capacity wait Issue WorkRequest was not prepared')
  } else {
    const repositoryState = await ghJson(['api', `repos/${repository}`], 'repository state')
    const defaultBranch = repositoryState.default_branch
    if (typeof defaultBranch !== 'string' || !defaultBranch) throw new Error('Repository default branch is missing')
    const baseCommit = await ghJson([
      'api', `repos/${repository}/commits/${encodeURIComponent(defaultBranch)}`,
    ], `default branch ${defaultBranch}`)
    if (!/^[0-9a-f]{40}$/.test(baseCommit?.sha || '')) throw new Error('Default branch head is not a full SHA')
    const profile = await targetProfile(work.work.profile, baseCommit.sha)
    const workflowId = work.work.workflow
    const workflow = resolveWorkflow(profile.definition, workflowId)
    const active = activeWorkflowIssueNumbers({
      issues,
      pullRequests,
      profileId: profile.definition.profileId,
      workflowId,
      excludeIssueNumber: requestedIssueNumber === work.number ? work.number : null,
    })
    if (active.size >= workflow.coordination.limit) {
      process.stdout.write(`Workflow ${profile.definition.profileId}/${workflowId} is at its coordination limit ${workflow.coordination.limit}.\n`)
      process.exit(0)
    }
    const requestId = agentWorkRequestId(work.work, profile.definitionHash)
    work.request = createIssueImplementationRequest({
      ...profile,
      workflowId,
      repository,
      issueNumber: work.number,
      base: baseCommit.sha,
      requestId,
    })
  }
}

if (capacityResumeOnly) {
  const output = capacityResumeOutput(work)
  await writeCapacityOutputs(output)
  process.stdout.write(`${JSON.stringify(output)}\n`)
  process.exit(0)
}

const admission = await admittedWork(work, pullRequests, issues)
if (!admission) process.exit(0)

if (work.type === 'repair') {
  await recordApplied(work, admission)
  await run(githubExecutable, [
    'api', '--method', 'POST', `repos/${repository}/dispatches`,
    '-f', 'event_type=dsh-repair',
    '-F', `client_payload[pr_number]=${work.number}`,
    '-f', `client_payload[head_sha]=${work.head}`,
    '-f', 'client_payload[request_id]=backlog',
  ], { env: githubEnvironment })
  process.stdout.write(`Dispatched blocked pull request #${work.number} at ${work.head}.\n`)
} else {
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
}
