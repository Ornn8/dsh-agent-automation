import { createHash } from 'node:crypto'
import {
  actionsCredentialEnvironment,
  githubLogin,
  hostCredentialEnvironment,
  loadConfig,
  parseJson,
  requiredEnv,
  run,
  verifyGithubIdentity,
} from './common.mjs'
import { dispatchWithReceipt } from './dispatch-receipt.mjs'
import { repairObservationIdFromGovernorRecord } from './advancement-runtime.mjs'
import { baseReconcileTransition, needsDefaultBranchUpdate, needsExactReview } from './reconciliation-policy.mjs'
import { hasTrustedExactReviewInvocation, hasTrustedExactReviewRun, reviewRunIdFromCheckRun } from './landing-policy.mjs'
import { parseCapacityWaitStatus } from './capacity-wait-projection.mjs'
import { parseReviewCheckIdentity } from './review-check.mjs'
import { trustedReviewRunProfile } from './advancement-source.mjs'
import {
  governorBudgetDecision,
  governorDecision,
  subjectStateVersion,
  unappliedGovernorCandidate,
} from './governor-policy.mjs'
import {
  attestedGovernorRecordBody,
  GOVERNOR_WORKFLOW_PATHS,
  pullRequestGovernorSubject,
  trustedGovernorRecords,
} from './governor-state.mjs'
import { createReviewRepairRequest, repositoryDispatchBody, resolveRepairEntryStage } from './work-request.mjs'
import { loadTrustedWorkflowProfile, resolveWorkflowStage } from './workflow-profile.mjs'
import { trustedWorkerIdentity } from './workflow-identity.mjs'
import { createLocalWorkerRoutingExecution } from './worker-routing.mjs'

const repository = requiredEnv('TARGET_REPOSITORY')
const defaultBranch = requiredEnv('DEFAULT_BRANCH')
const config = await loadConfig()
await verifyGithubIdentity({ config })
const trustedControllerLogin = githubLogin(config)
const githubExecutable = config.ghExecutable
const githubEnvironment = hostCredentialEnvironment()
const actionsEnvironment = actionsCredentialEnvironment()
const trustedReview = {
  controllerRepository: requiredEnv('TRUSTED_CONTROLLER_REPOSITORY'),
  controllerSha: requiredEnv('TRUSTED_CONTROLLER_SHA'),
  workflowPath: requiredEnv('TRUSTED_REVIEW_WORKFLOW_PATH'),
}
if (!/^[0-9a-f]{40}$/i.test(trustedReview.controllerSha)) throw new Error('TRUSTED_CONTROLLER_SHA must be a full commit SHA')
const governorTrust = {
  repository,
  controllerRepository: trustedReview.controllerRepository,
  controllerSha: trustedReview.controllerSha.toLowerCase(),
  workflowPaths: GOVERNOR_WORKFLOW_PATHS,
}
const governorWriterTrust = {
  ...governorTrust,
  workflowPath: '.github/workflows/reconcile-reviews.yml',
}
delete governorWriterTrust.workflowPaths
const governorRunId = Number.parseInt(requiredEnv('GITHUB_RUN_ID'), 10)
const governorObservationId = `${governorRunId}:${process.env.GITHUB_RUN_ATTEMPT || '1'}`
const updatePollAttempts = 10
const updatePollDelayMs = 1_000

async function ghJson(args, description) {
  const result = await run(githubExecutable, args, { env: githubEnvironment })
  return parseJson(result.stdout, description)
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

async function actionsJson(args, description) {
  const result = await run(githubExecutable, args, { env: actionsEnvironment })
  return parseJson(result.stdout, description)
}

async function pullRequestGovernorRecords(number) {
  const comments = (await actionsJson([
    'api', `repos/${repository}/issues/${number}/comments?per_page=100`, '--paginate', '--slurp',
  ], `pull request #${number} governor records`)).flat()
  return trustedGovernorRecords({
    comments,
    trust: governorTrust,
    loadRun: runId => actionsJson(['api', `repos/${repository}/actions/runs/${runId}`], `governor workflow run ${runId}`),
  })
}

async function writeGovernorRecord(number, record) {
  await run(githubExecutable, [
    'api', '--method', 'POST', `repos/${repository}/issues/${number}/comments`, '--input', '-',
  ], {
    env: actionsEnvironment,
    input: JSON.stringify({
      body: attestedGovernorRecordBody(record, { ...governorWriterTrust, runId: governorRunId }),
    }),
  })
}

async function governTransition(pullRequest, transition, { limit, workIdentity, budgetTransition = transition } = {}) {
  const subject = pullRequestGovernorSubject(pullRequest)
  const stateVersion = subjectStateVersion(subject)
  const records = await pullRequestGovernorRecords(pullRequest.number)
  const admitted = records.find(record => record.status === 'admitted'
    && record.transition === transition && record.stateVersion === stateVersion)
  const decision = governorDecision({
    transition, subject, stateVersion, observationId: governorObservationId, records,
  })
  if (decision.record) await writeGovernorRecord(pullRequest.number, decision.record)
  if (!decision.execute && (!admitted || decision.action !== 'wait')) {
    return { execute: false, action: decision.action }
  }
  if (!decision.execute && !limit) return { execute: true, replay: true, subject, stateVersion }
  if (limit) {
    const budget = governorBudgetDecision({
      transition: budgetTransition,
      subject: { type: subject.type, number: subject.number },
      workIdentity,
      observationId: decision.record?.observationId || admitted?.observationId || governorObservationId,
      limit,
      records,
    })
    if (budget.record) await writeGovernorRecord(pullRequest.number, budget.record)
    if (!budget.execute && !(admitted && budget.action === 'noop')) {
      if (budget.action !== 'pause') return { execute: false, action: budget.action }
      await run(githubExecutable, [
        'label', 'create', 'automation/paused', '--repo', repository,
        '--description', 'Automatic governor budget exhausted', '--color', 'D93F0B',
      ], { env: githubEnvironment }).catch(() => undefined)
      await run(githubExecutable, [
        'pr', 'edit', String(pullRequest.number), '--repo', repository,
        '--add-label', 'automation/paused',
      ], { env: githubEnvironment })
      return { execute: false, action: 'pause' }
    }
  }
  return { execute: true, ...(admitted ? { replay: true } : {}), subject, stateVersion }
}

async function persistedWorkflowIdentity(pullRequest) {
  const comments = (await actionsJson([
    'api', `repos/${repository}/issues/${pullRequest.number}/comments?per_page=100`, '--paginate', '--slurp',
  ], `pull request #${pullRequest.number} Worker comments`)).flat()
  for (const comment of comments.slice().reverse()) {
    const identity = await trustedWorkerIdentity(comment,
      { type: 'pull-request', number: pullRequest.number }, 'repair-worker', repository,
      runId => actionsJson(['api', `repos/${repository}/actions/runs/${runId}`], `Worker run ${runId}`), trustedControllerLogin)
    if (identity?.branch === pullRequest.head.ref) return identity
  }
  const references = await actionsJson([
    'pr', 'view', String(pullRequest.number), '--repo', repository, '--json', 'closingIssuesReferences',
  ], `pull request #${pullRequest.number} closing Issues`)
  for (const reference of references.closingIssuesReferences || []) {
    if (!Number.isSafeInteger(reference?.number)) continue
    const issueComments = (await actionsJson([
      'api', `repos/${repository}/issues/${reference.number}/comments?per_page=100`, '--paginate', '--slurp',
    ], `Issue #${reference.number} Worker comments`)).flat()
    for (const comment of issueComments.slice().reverse()) {
      const identity = await trustedWorkerIdentity(comment,
        { type: 'issue', number: reference.number }, 'change-worker', repository,
        runId => actionsJson(['api', `repos/${repository}/actions/runs/${runId}`], `Worker run ${runId}`), trustedControllerLogin)
      if (identity?.branch === pullRequest.head.ref) return identity
    }
  }
  return null
}

async function markGovernorApplied(pullRequest, transition, governed) {
  await writeGovernorRecord(pullRequest.number, {
    version: 1,
    status: 'applied',
    transition,
    subject: { type: governed.subject.type, number: governed.subject.number },
    stateVersion: governed.stateVersion,
    observationId: governorObservationId,
  })
}

const summaries = await ghJson([
  'api', `repos/${repository}/pulls?state=open&per_page=100`, '--paginate', '--slurp',
], 'open pull requests')
const defaultBranchReference = await ghJson([
  'api', `repos/${repository}/git/ref/heads/${encodeURIComponent(defaultBranch)}`,
], `default branch ${defaultBranch}`)
const defaultBranchHead = defaultBranchReference?.object?.sha
if (!/^[0-9a-f]{40}$/i.test(defaultBranchHead || '')) {
  throw new Error(`Default branch ${defaultBranch} did not resolve to a commit SHA`)
}

async function requestAdvancement(pullRequest, reviewConfiguration = null) {
  for (const label of ['automation/ci-baseline', 'automation/repair-blocked']) {
    if (!pullRequest.labels?.some(candidate => candidate.name === label)) continue
    await run(githubExecutable, [
      'pr', 'edit', String(pullRequest.number), '--repo', repository,
      '--remove-label', label,
    ], { env: githubEnvironment })
  }
  await run(githubExecutable, [
    'label', 'create', 'automation/review-ready', '--repo', repository,
    '--description', 'Request one exact-pair Agent review', '--color', '0E8A16',
  ], { env: githubEnvironment }).catch(() => undefined)
  await run(githubExecutable, [
    'pr', 'edit', String(pullRequest.number), '--repo', repository,
    '--add-label', 'automation/review-ready',
  ], { env: githubEnvironment })
  const requestId = `reconcile-${createHash('sha256').update([
    pullRequest.base.sha,
    pullRequest.head.sha,
    reviewConfiguration?.profileId || 'github-pr-cycle',
    reviewConfiguration?.workflowId || '',
  ].join(':')).digest('hex').slice(0, 32)}`
  await dispatchWithReceipt({
    executable: githubExecutable, environment: actionsEnvironment, repository,
    workflowFile: 'agent-pr-land.yml',
    payload: {
      event_type: 'dsh-advance',
      client_payload: {
        pull_request_number: pullRequest.number,
        base_sha: pullRequest.base.sha,
        head_sha: pullRequest.head.sha,
        profile_id: reviewConfiguration?.profileId || 'github-pr-cycle',
        workflow_id: reviewConfiguration?.workflowId || '',
        request_id: requestId,
      },
    },
    requestId,
  })
}

async function requestCapacityReviewResume(pullRequest, projection) {
  if (projection.revision.base !== pullRequest.base.sha || projection.revision.head !== pullRequest.head.sha) {
    throw new Error(`Capacity wait review projection is stale for pull request #${pullRequest.number}`)
  }
  const profile = await targetProfile(projection.profileId, pullRequest.base.sha)
  if (profile.definitionHash !== projection.definitionHash) {
    throw new Error(`Capacity wait review Profile is stale for pull request #${pullRequest.number}`)
  }
  const stage = resolveWorkflowStage(profile.definition, projection.workflowId, projection.stageId, 'worker')
  if (stage.role !== 'review') throw new Error(`Capacity wait review Stage is no longer a review Stage for pull request #${pullRequest.number}`)
  createLocalWorkerRoutingExecution({
    routeDecision: projection.routeDecision,
    workRequest: { requestId: projection.workRequestId, role: 'review' },
    subjectStateVersion: projection.subject.stateVersion,
    trustedTaskSnapshot: { workflowStage: projection.stageId },
    routingPolicy: config.operations.routing.review,
  })
  const dispatchRequestId = `capacity-resume:${projection.observationId}`
  await dispatchWithReceipt({
    executable: githubExecutable,
    environment: actionsEnvironment,
    repository,
    workflowFile: 'agent-pr-review.yml',
    payload: {
      event_type: 'agent-review',
      client_payload: {
        pull_request_number: pullRequest.number,
        base_sha: projection.revision.base,
        head_sha: projection.revision.head,
        profile_id: projection.profileId,
        workflow_id: projection.workflowId,
        stage_id: projection.stageId,
        request_id: dispatchRequestId,
      },
    },
    requestId: dispatchRequestId,
  })
}

async function waitForUpdatedPair(pullRequest) {
  for (let attempt = 1; attempt <= updatePollAttempts; attempt += 1) {
    const current = await ghJson([
      'api', `repos/${repository}/pulls/${pullRequest.number}`,
    ], `updated pull request #${pullRequest.number}`)
    if (current.state !== 'open'
      || current.draft
      || current.base?.ref !== defaultBranch
      || current.head?.repo?.full_name !== repository) {
      throw new Error(`Pull request #${pullRequest.number} changed while updating its base`)
    }
    if (current.base.sha === defaultBranchHead && current.head.sha !== pullRequest.head.sha) return current
    if (attempt < updatePollAttempts) {
      await new Promise(resolvePromise => setTimeout(resolvePromise, updatePollDelayMs))
    }
  }
  throw new Error(`Pull request #${pullRequest.number} did not expose its updated exact pair`)
}

let reconciled = 0
for (const summary of summaries.flat()) {
  const pullRequest = await ghJson([
    'api', `repos/${repository}/pulls/${summary.number}`,
  ], `pull request #${summary.number}`)
  if (pullRequest.draft
    || pullRequest.base?.ref !== defaultBranch
    || pullRequest.head?.repo?.full_name !== repository) continue
  if (pullRequest.labels?.some(label => label.name === 'automation/paused')) continue
  const comparison = await ghJson([
    'api', `repos/${repository}/compare/${defaultBranchHead}...${pullRequest.head.sha}`,
  ], `default-branch ancestry for pull request #${summary.number}`)
  const mergeBaseSha = comparison?.merge_base_commit?.sha
  if (!/^[0-9a-f]{40}$/i.test(mergeBaseSha || '')) {
    throw new Error(`Pull request #${summary.number} comparison did not return a merge-base commit`)
  }
  if (needsDefaultBranchUpdate({ defaultBranch, defaultBranchHead, mergeBaseSha, pullRequest })) {
    const transition = baseReconcileTransition(defaultBranchHead)
    const governed = await governTransition(pullRequest, transition, {
      limit: 3,
      workIdentity: `branch:${pullRequest.head.ref}`,
      budgetTransition: 'base-reconcile',
    })
    if (!governed.execute) continue
    await run(githubExecutable, [
      'api', '--method', 'PUT', `repos/${repository}/pulls/${pullRequest.number}/update-branch`,
      '-f', `expected_head_sha=${pullRequest.head.sha}`,
    ], { env: githubEnvironment })
    await waitForUpdatedPair(pullRequest)
    await markGovernorApplied(pullRequest, transition, governed)
    reconciled += 1
    process.stdout.write(`Updated pull request #${pullRequest.number} from ${defaultBranch}; GitHub will deliver its new exact pair to CI and review listeners.\n`)
    continue
  }
  const landingPullRequest = {
    number: pullRequest.number, repository, state: pullRequest.state.toUpperCase(), isDraft: pullRequest.draft,
    baseRefName: pullRequest.base.ref,
    baseRefOid: pullRequest.base.sha, headRefOid: pullRequest.head.sha, mergeStateStatus: 'CLEAN',
  }
  const checkRunPages = await ghJson([
    'api', `repos/${repository}/commits/${pullRequest.head.sha}/check-runs`, '--paginate', '--slurp',
  ], `pull request #${summary.number} check runs`)
  const checkRuns = checkRunPages.flatMap(page => page.check_runs || [])
  let reviewProof = null
  let reviewConfiguration = null
  let capacityProjection = null
  let reviewInProgress = false
  for (const checkRun of checkRuns) {
    const runId = reviewRunIdFromCheckRun(checkRun, repository)
    if (!runId || checkRun.name !== 'agent/review') continue
    const workflowRun = await ghJson(['api', `repos/${repository}/actions/runs/${runId}`], `review workflow run ${runId}`)
    const proof = { checkRun, run: workflowRun }
    if (!hasTrustedExactReviewInvocation({ pullRequest: landingPullRequest, reviewProof: proof, trustedReview })) {
      continue
    }
    if (String(checkRun.status).toUpperCase() !== 'COMPLETED') reviewInProgress = true
    const identity = parseReviewCheckIdentity(checkRun)
    let profile = null
    try {
      profile = trustedReviewRunProfile(workflowRun, {
        repository,
        controllerRepository: trustedReview.controllerRepository,
        controllerSha: trustedReview.controllerSha,
        workflowPath: trustedReview.workflowPath,
        number: pullRequest.number,
        base: pullRequest.base.sha,
        head: pullRequest.head.sha,
      })
    } catch {
      continue
    }
    reviewConfiguration = identity && profile
      ? { profileId: profile.profileId, workflowId: identity.workflowId }
      : null
    if (identity && profile
      && String(checkRun.status).toUpperCase() === 'COMPLETED'
      && String(checkRun.conclusion).toUpperCase() === 'NEUTRAL') {
      try {
        const candidate = parseCapacityWaitStatus(checkRun.output?.summary)
        if (candidate.subject.type === 'pull-request'
          && candidate.subject.number === pullRequest.number
          && candidate.workRequestId === candidate.routeDecision.workRequestId
          && candidate.role === 'review'
          && candidate.profileId === profile.profileId
          && candidate.workflowId === identity.workflowId
          && candidate.stageId === identity.stageId
          && candidate.definitionHash === profile.definitionHash) {
          capacityProjection = candidate
        }
      } catch {
        // A neutral review without the strict capacity projection is not resumable.
      }
    }
    const passed = ['SUCCESS', 'success'].includes(checkRun.conclusion)
      && workflowRun.conclusion === 'success'
    const blocked = ['FAILURE', 'failure'].includes(checkRun.conclusion)
      && workflowRun.conclusion === 'failure'
      && pullRequest.labels?.some(label => label.name === 'automation/review-blocked')
    if (!passed && !blocked) continue
    reviewProof = { base: pullRequest.base.sha, head: pullRequest.head.sha, state: passed ? 'pass' : 'block' }
    if (!hasTrustedExactReviewRun({ pullRequest: landingPullRequest, reviewProof: proof, trustedReview })) continue
    break
  }
  const persistedIdentity = await persistedWorkflowIdentity(pullRequest)
  if (reviewConfiguration && persistedIdentity
    && (reviewConfiguration.profileId !== persistedIdentity.profileId
      || reviewConfiguration.workflowId !== persistedIdentity.workflowId)) {
    throw new Error(`Pull request #${pullRequest.number} has conflicting trusted Worker workflow identities`)
  }
  const workflowIdentity = reviewConfiguration || persistedIdentity
  const subject = pullRequestGovernorSubject(pullRequest)
  const stateVersion = subjectStateVersion(subject)
  const governorRecords = await pullRequestGovernorRecords(pullRequest.number)
  const pendingRecord = unappliedGovernorCandidate(governorRecords.slice().reverse(), record =>
    (record.transition === 'workflow-recovery'
      || record.transition === 'review-repair'
      || record.transition.startsWith('review-repair:')
      || record.transition === 'merge-repair'
      || record.transition.startsWith('merge-repair:'))
    && record.subject.type === 'pull-request'
    && record.subject.number === pullRequest.number
    && record.stateVersion === stateVersion)
  const pendingTransition = pendingRecord?.transition
  if (pendingTransition) {
    const reviewRepair = pendingTransition === 'review-repair' || pendingTransition.startsWith('review-repair:')
    const mergeRepair = pendingTransition === 'merge-repair' || pendingTransition.startsWith('merge-repair:')
    const repairProfile = reviewRepair || mergeRepair
      ? await targetProfile(workflowIdentity?.profileId || 'github-pr-cycle', pullRequest.base.sha)
      : null
    if (persistedIdentity && repairProfile?.definitionHash !== persistedIdentity.definitionHash) {
      throw new Error(`Pull request #${pullRequest.number} Worker Profile hash does not match its base`)
    }
    const repairStage = repairProfile ? resolveRepairEntryStage(repairProfile.definition) : null
    const repairLimit = repairStage?.stage.retry?.limit ?? (pendingTransition === 'workflow-recovery' ? 3 : undefined)
    if (!Number.isSafeInteger(repairLimit)) throw new Error('Repair Profile must declare a bounded retry limit')
    const governed = await governTransition(pullRequest, pendingTransition, {
      limit: repairLimit,
      workIdentity: `branch:${pullRequest.head.ref}`,
      ...((reviewRepair || mergeRepair) ? { budgetTransition: mergeRepair ? 'merge-repair' : 'review-repair' } : {}),
    })
    if (governed.execute) {
      if (reviewRepair) {
        const observationId = repairObservationIdFromGovernorRecord(pendingTransition, pendingRecord)
        const request = createReviewRepairRequest({
          ...repairProfile,
          repository,
          pullRequestNumber: pullRequest.number,
          base: pullRequest.base.sha,
          head: pullRequest.head.sha,
          reviewObservationId: observationId,
        })
        await dispatchWithReceipt({
          executable: githubExecutable, environment: actionsEnvironment,
          workflowFile: 'agent-pr-rework.yml', payload: repositoryDispatchBody(request),
          requestId: request.requestId,
        })
      } else if (mergeRepair) {
        const request = createReviewRepairRequest({
          ...repairProfile,
          repository,
          pullRequestNumber: pullRequest.number,
          base: pullRequest.base.sha,
          head: pullRequest.head.sha,
          reviewObservationId: repairObservationIdFromGovernorRecord(pendingTransition, pendingRecord),
        })
        const dispatch = repositoryDispatchBody(request)
        dispatch.client_payload.repair_cause = 'merge-conflict'
        await dispatchWithReceipt({
          executable: githubExecutable, environment: actionsEnvironment, repository,
          workflowFile: 'agent-pr-rework.yml', payload: dispatch, requestId: request.requestId,
        })
      } else {
        await requestAdvancement(pullRequest, workflowIdentity)
      }
      await markGovernorApplied(pullRequest, pendingTransition, governed)
      reconciled += 1
      continue
    }
    if (governed.action !== 'noop') continue
  }
  if (capacityProjection && !reviewProof && !reviewInProgress) {
    await requestCapacityReviewResume(pullRequest, capacityProjection)
    reconciled += 1
    continue
  }
  if (reviewConfiguration && !reviewProof) continue
  if (!needsExactReview({ repository, defaultBranch, pullRequest, reviewProof })) continue

  await requestAdvancement(pullRequest, workflowIdentity)
  reconciled += 1
}
process.stdout.write(`Reconciled ${reconciled} pull request(s).\n`)
