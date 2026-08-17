import { mkdtemp } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import {
  actionsCredentialEnvironment,
  hostCredentialEnvironment,
  githubLogin,
  authenticatedMarker,
  loadConfig,
  parseJson,
  processCancellationSignal,
  removeJobDirectory,
  resolveRepositoryWorker,
  requiredEnv,
  run,
  trustedAssociation,
  verifyGithubIdentity,
} from './common.mjs'
import {
  ciRepairRequest,
  ciRepairTransition,
  explicitReworkCommand,
  trustedCiFailure,
  trustedCiRerunSuccess,
} from './dispatch-policy.mjs'
import { createAgentAdapters } from './agent-adapters.mjs'
import { controllerMutationMarker } from './controller-mutation-marker.mjs'
import { runAgentWorker } from './agent-worker.mjs'
import {
  interruptedRepairMayRetry,
  recordedRepairState,
} from './repair-state.mjs'
import {
  ciBaselineIssueFromReceipt,
  nonBaselineBlockFromReceipt,
  trustedBaselineIssue,
} from './baseline-issue.mjs'
import { isReviewRepairRequestId, parseAgentWorkRequest, reviewRepairTransition } from './work-request.mjs'
import { AGENT_REPAIR_SKILL, agentWorkPrompt } from './agent-work-result.mjs'
import { classifyAgentFailure } from './failure-classification.mjs'
import { hasNewReviewCheck, trustedReviewCheckIds } from './review-check.mjs'
import { governorBudgetDecision, governorDecision, subjectStateVersion } from './governor-policy.mjs'
import {
  attestedGovernorRecordBody,
  GOVERNOR_WORKFLOW_PATHS,
  pullRequestGovernorSubject,
  trustedGovernorRecords,
} from './governor-state.mjs'
import { loadTrustedWorkflowProfile, resolveWorkflowStage } from './workflow-profile.mjs'
import { resolveGithubPrCycle } from './github-pr-cycle.mjs'

const REREVIEW_OBSERVATION_ATTEMPTS = 5
const REREVIEW_OBSERVATION_DELAY_MS = 2_000

const repository = requiredEnv('TARGET_REPOSITORY')
let pullRequestNumber = Number.parseInt(requiredEnv('PR_NUMBER'), 10)
const expectedHead = requiredEnv('HEAD_SHA')
const requestId = process.env.REPAIR_REQUEST_ID?.trim() || ''
const transportedRequest = process.env.WORK_REQUEST_JSON?.trim()
  ? parseAgentWorkRequest(parseJson(process.env.WORK_REQUEST_JSON, 'WorkRequest'))
  : null
const ciWorkflowName = process.env.CI_WORKFLOW_NAME?.trim() || ''
const runnerTemp = resolve(requiredEnv('RUNNER_TEMP'))
const config = await loadConfig()
const workerId = resolveRepositoryWorker(config, repository, transportedRequest?.role || requiredEnv('AGENT_ROLE'))
const cancellation = processCancellationSignal()
const defaultBranch = requiredEnv('DEFAULT_BRANCH')
const markerAuthor = githubLogin(config)
const controllerSha = requiredEnv('CONTROLLER_SHA').toLowerCase()
const controllerRepository = requiredEnv('CONTROLLER_REPOSITORY')
const governorRunId = Number.parseInt(requiredEnv('GITHUB_RUN_ID'), 10)
const governorObservationId = `${governorRunId}:${process.env.GITHUB_RUN_ATTEMPT || '1'}`
const actionsEnvironment = actionsCredentialEnvironment()
const governorTrust = {
  repository,
  controllerRepository,
  workflowPaths: GOVERNOR_WORKFLOW_PATHS,
}
const governorWriterTrust = {
  repository,
  controllerRepository,
  controllerSha,
  workflowPath: '.github/workflows/dsh-repair.yml',
}
if (requestId && !/^[A-Za-z0-9._-]{1,100}$/.test(requestId)) throw new Error('Invalid REPAIR_REQUEST_ID')
if (!/^[0-9a-f]{40}$/.test(controllerSha)) throw new Error('CONTROLLER_SHA must be a full lowercase commit SHA')
const marker = requestId
  ? `<!-- dsh-review-repair:${controllerSha}:${expectedHead}:${requestId} -->`
  : `<!-- dsh-review-repair:${controllerSha}:${expectedHead} -->`
const ciRequest = ciRepairRequest(requestId)
const explicitRequest = Boolean(ciRequest)
  || (!isReviewRepairRequestId(requestId, expectedHead)
    && requestId.startsWith('comment-'))
const recoveryRequest = /(?:^recovery-|\.recovery-\d+$)/.test(requestId)
const repairClass = ciRequest
  ? 'automatic-ci'
  : explicitRequest
    ? 'explicit-human'
    : 'automatic-review'
const reviewObservationId = transportedRequest && isReviewRepairRequestId(transportedRequest.requestId, expectedHead)
  ? transportedRequest.requestId.slice(`review-repair-${expectedHead}-`.length)
  : null

if (!config.repositories.includes(repository)) throw new Error(`${repository} is not in the runner allowlist`)
if (transportedRequest && (transportedRequest.repository !== repository
  || transportedRequest.subject.type !== 'pull-request'
  || transportedRequest.subject.number !== pullRequestNumber
  || transportedRequest.revision.head !== expectedHead
  || transportedRequest.requestId !== requestId)) {
  throw new Error('Transported WorkRequest does not match the repair invocation')
}
if (!Number.isSafeInteger(pullRequestNumber) || pullRequestNumber < 0) {
  throw new Error(`Invalid PR_NUMBER: ${process.env.PR_NUMBER}`)
}

async function ghJson(args, description) {
  const result = await run(config.ghExecutable, args, { env: hostCredentialEnvironment() })
  return parseJson(result.stdout, description)
}

async function actionsJson(args, description) {
  const result = await run(config.ghExecutable, args, { env: actionsEnvironment })
  return parseJson(result.stdout, description)
}

async function targetProfile(request) {
  return loadTrustedWorkflowProfile({
    repository,
    revision: request.revision.base,
    profileId: request.profileId,
    loadContent: async ({ path, revision }) => {
      const content = await ghJson([
        'api', '--method', 'GET', `repos/${repository}/contents/${path}`, '-f', `ref=${revision}`,
      ], `Profile ${request.profileId} at ${revision}`)
      if (content?.encoding !== 'base64' || typeof content.content !== 'string') {
        throw new Error(`Profile ${request.profileId} is not a GitHub file`)
      }
      return Buffer.from(content.content.replace(/\s/g, ''), 'base64').toString('utf8')
    },
  })
}

async function writeGovernorRecord(record) {
  await run(config.ghExecutable, [
    'api', '--method', 'POST', `repos/${repository}/issues/${pullRequestNumber}/comments`, '--input', '-',
  ], {
    env: actionsEnvironment,
    input: JSON.stringify({
      body: attestedGovernorRecordBody(record, { ...governorWriterTrust, runId: governorRunId }),
    }),
  })
}

await verifyGithubIdentity({ config })

if (pullRequestNumber === 0) {
  if (!ciRequest) throw new Error('PR_NUMBER=0 is permitted only for exact-head CI repair')
  const candidates = await ghJson([
    'pr', 'list', '--repo', repository, '--state', 'open',
    '--json', 'number,headRefOid', '--limit', '101',
  ], 'open pull requests for CI repair')
  if (candidates.length > 100) throw new Error('CI repair exceeded its bounded 100 pull request snapshot')
  const matches = candidates.filter(candidate => candidate.headRefOid === expectedHead)
  if (matches.length !== 1) {
    throw new Error(`Expected one open pull request at ${expectedHead}, found ${matches.length}`)
  }
  pullRequestNumber = matches[0].number
}

async function upsertStatus(status, branch, detail, failureClass) {
  const runUrl = requiredEnv('RUN_URL')
  const body = [
    marker,
    ciRequest ? '### DSH CI repair' : '### DSH review repair',
    '',
    `- Status: **${status}**`,
    `- Controller SHA: \`${controllerSha}\``,
    `- Repair class: \`${repairClass}\``,
    ...(ciRequest ? [`- CI workflow: \`${ciWorkflowName}\``] : []),
    `- Reviewed head: \`${expectedHead}\``,
    `- Branch: \`${branch}\``,
    `- Run: ${runUrl}`,
    ...(failureClass ? [`- Failure class: \`${failureClass}\``] : []),
    `- Detail: ${detail}`,
    '',
    '_DSH owns the technical response and any implementation changes._',
    '',
    controllerMutationMarker({
      version: 1,
      operation: 'repair-worker',
      repository,
      subject: { type: 'pull-request', number: pullRequestNumber },
      runUrl,
      controller: {
        repository: controllerRepository,
        workflowPath: '.github/workflows/dsh-repair.yml',
        sha: controllerSha,
      },
    }),
  ].join('\n')
  const comments = (await ghJson([
    'api', `repos/${repository}/issues/${pullRequestNumber}/comments?per_page=100`, '--paginate', '--slurp',
  ], 'pull request comments')).flat()
  const prior = comments.find(comment => authenticatedMarker(comment, marker, markerAuthor))
  if (prior) {
    await run(config.ghExecutable, [
      'api', '--method', 'PATCH', `repos/${repository}/issues/comments/${prior.id}`, '-f', `body=${body}`,
    ], { env: hostCredentialEnvironment() })
  } else {
    await run(config.ghExecutable, [
      'pr', 'comment', String(pullRequestNumber), '--repo', repository, '--body', body,
    ], { env: hostCredentialEnvironment() })
  }
}

async function setRepairLabels({ add = [], remove = [] }) {
  for (const [name, description, color] of [
    ['automation/review-blocked', 'Agent review found a blocking defect at the current PR head', 'B60205'],
    ['automation/ci-failed', 'A failed CI run requires DSH repair at the current PR head', 'D93F0B'],
    ['automation/ci-baseline', 'The failed CI condition is tracked by a separate default-branch Issue', '1D76DB'],
    ['automation/repair-blocked', 'DSH ended this repair with a valid blocked outcome', 'B60205'],
    ['automation/repairing', 'DSH is addressing the current blocking review', 'FBCA04'],
    ['automation/paused', 'Automatic controller work is paused until an authorized resume', 'D93F0B'],
    ['agent/dsh-failed', 'DSH execution failed; an explicit recovery request is required', 'D93F0B'],
  ]) {
    if (add.includes(name)) {
      await run(config.ghExecutable, [
        'label', 'create', name, '--repo', repository,
        '--description', description, '--color', color,
      ], { env: hostCredentialEnvironment() }).catch(() => undefined)
      await run(config.ghExecutable, [
        'pr', 'edit', String(pullRequestNumber), '--repo', repository,
        '--add-label', name,
      ], { env: hostCredentialEnvironment() }).catch(() => undefined)
    }
  }
  for (const label of remove) {
    await run(config.ghExecutable, [
      'pr', 'edit', String(pullRequestNumber), '--repo', repository,
      '--remove-label', label,
    ], { env: hostCredentialEnvironment() }).catch(() => undefined)
  }
}

async function reviewCheckIds() {
  const response = await ghJson([
    'api', `repos/${repository}/commits/${expectedHead}/check-runs?per_page=100`,
  ], 'review CheckRuns')
  return trustedReviewCheckIds(response, { repository, head: expectedHead })
}

async function sameHeadRereviewRequested(current, priorCheckIds) {
  if (current.labels.some(label => label.name === 'automation/review-ready')) return true
  for (let attempt = 0; attempt < REREVIEW_OBSERVATION_ATTEMPTS; attempt += 1) {
    if (hasNewReviewCheck(priorCheckIds, await reviewCheckIds())) return true
    if (attempt + 1 < REREVIEW_OBSERVATION_ATTEMPTS) {
      await delay(REREVIEW_OBSERVATION_DELAY_MS)
    }
  }
  return false
}

const pullRequest = await ghJson(['api', `repos/${repository}/pulls/${pullRequestNumber}`], 'pull request')
let repairProcedure = AGENT_REPAIR_SKILL
let transportedProfile = null
if (transportedRequest) {
  if (pullRequest.base?.sha !== transportedRequest.revision.base) {
    throw new Error('Transported WorkRequest base no longer matches the pull request')
  }
  transportedProfile = await targetProfile(transportedRequest)
  if (transportedProfile.definitionHash !== transportedRequest.definitionHash) {
    throw new Error('Transported WorkRequest Profile hash does not match the trusted pull request base')
  }
  const stage = resolveWorkflowStage(
    transportedProfile.definition,
    transportedRequest.workflowId,
    transportedRequest.stageId,
    'worker',
  )
  if (stage.role !== transportedRequest.role) {
    throw new Error('Transported WorkRequest role does not match the trusted repair Stage')
  }
  repairProcedure = stage.procedure
}

async function requestTransportedReview(current) {
  if (!transportedRequest || !transportedProfile) return false
  const cycle = resolveGithubPrCycle(transportedProfile.definition, transportedRequest.workflowId)
  await run(config.ghExecutable, [
    'api', '--method', 'POST', `repos/${repository}/dispatches`, '--input', '-',
  ], {
    env: hostCredentialEnvironment(),
    input: JSON.stringify({
      event_type: 'agent-review',
      client_payload: {
        pull_request_number: pullRequestNumber,
        base_sha: current.base.sha,
        head_sha: current.head.sha,
        profile_id: transportedRequest.profileId,
        workflow_id: transportedRequest.workflowId,
        stage_id: cycle.review.id,
        request_id: `repair-complete-${current.head.sha}`,
      },
    }),
  })
  return true
}

if (pullRequest.state !== 'open') throw new Error(`Pull request #${pullRequestNumber} is not open`)
if (pullRequest.draft) throw new Error(`Pull request #${pullRequestNumber} is still a draft`)
if (pullRequest.head.repo?.full_name !== repository) throw new Error('Fork pull requests cannot reach the DSH repair agent')
if (pullRequest.head.sha !== expectedHead) {
  if (!await requestTransportedReview(pullRequest)) throw new Error('The pull request head changed before DSH repair started')
  await setRepairLabels({ remove: ['automation/review-blocked', 'automation/ci-failed', 'automation/ci-baseline', 'automation/repair-blocked', 'automation/repairing', 'agent/dsh-failed'] })
  await upsertStatus('complete', branch, `The interrupted repair had already advanced the pull request to ${pullRequest.head.sha}; the trusted Profile workflow requested its exact-head review.`)
  process.stdout.write(`Recovered the completed repair for pull request #${pullRequestNumber} at ${pullRequest.head.sha}.\n`)
  process.exit(0)
}
let ciRun
if (ciRequest) {
  if (!ciWorkflowName) throw new Error('CI_WORKFLOW_NAME is required for a CI repair request')
  ciRun = await ghJson(['api', `repos/${repository}/actions/runs/${ciRequest.runId}`], 'CI workflow run')
  if (ciRun.run_attempt !== ciRequest.attempt) throw new Error('CI workflow run attempt changed')
  if (!trustedCiFailure({
    run: ciRun, pullRequestNumber, expectedHead, workflowName: ciWorkflowName,
  })) {
    throw new Error('Workflow run is not trusted failed CI evidence for this pull request head')
  }
} else if (explicitRequest) {
  const feedbackId = Number.parseInt(requestId.slice('comment-'.length), 10)
  if (!Number.isSafeInteger(feedbackId) || feedbackId < 1) throw new Error('Invalid explicit repair request id')
  const comment = await ghJson(['api', `repos/${repository}/issues/comments/${feedbackId}`], 'rework comment')
  if (!comment.issue_url?.endsWith(`/issues/${pullRequestNumber}`)) {
    throw new Error('Rework comment does not belong to this pull request')
  }
  if (!trustedAssociation(comment.author_association)) {
    throw new Error(`Untrusted rework comment association ${comment.author_association}`)
  }
  if (!explicitReworkCommand(comment.body)) throw new Error('Comment is not an explicit DSH rework command')
}
if (!explicitRequest && !pullRequest.labels.some(label => label.name === 'automation/review-blocked')) {
  throw new Error('The pull request no longer has the automation/review-blocked label')
}

const priorComments = (await ghJson([
  'api', `repos/${repository}/issues/${pullRequestNumber}/comments?per_page=100`, '--paginate', '--slurp',
], 'pull request comments')).flat()
const governorRecords = await trustedGovernorRecords({
  comments: priorComments,
  trust: governorTrust,
  loadRun: runId => actionsJson(['api', `repos/${repository}/actions/runs/${runId}`], `governor workflow run ${runId}`),
})
const governorSubject = pullRequestGovernorSubject(pullRequest)
const governorStateVersion = subjectStateVersion(governorSubject)
if (pullRequest.labels.some(label => label.name === 'automation/paused')) {
  throw new Error(`Pull request #${pullRequestNumber} is paused and requires an authorized resume`)
}
const governedTransition = ciRequest
  ? ciRepairTransition(ciRequest.runId)
  : reviewObservationId
    ? reviewRepairTransition(reviewObservationId)
    : 'review-repair'
const budgetTransition = ciRequest ? 'ci-repair' : 'review-repair'
if (ciRequest && !recoveryRequest) {
  const admission = governorDecision({
    transition: governedTransition,
    subject: governorSubject,
    stateVersion: governorStateVersion,
    observationId: governorObservationId,
    records: governorRecords,
  })
  if (admission.record) await writeGovernorRecord(admission.record)
  if (!admission.execute) {
    if (admission.action === 'record-candidate') {
      await run(config.ghExecutable, [
        'run', 'rerun', String(ciRun.id), '--repo', repository,
      ], { env: hostCredentialEnvironment() })
      process.stdout.write(`Recorded CI repair candidate and requested one deterministic rerun of workflow ${ciRun.id}.\n`)
    } else {
      process.stdout.write(`Governor ${admission.action}; CI repair did not start a model.\n`)
    }
    cancellation.dispose()
    process.exit(0)
  }
  const budget = governorBudgetDecision({
    transition: budgetTransition,
    subject: { type: governorSubject.type, number: governorSubject.number },
    workIdentity: `branch:${pullRequest.head.ref}`,
    observationId: governorObservationId,
    limit: 3,
    records: governorRecords,
  })
  if (budget.record) await writeGovernorRecord(budget.record)
  if (!budget.execute) {
    if (budget.action !== 'pause') {
      cancellation.dispose()
      process.stdout.write(`Governor ${budget.action}; CI repair did not start a model.\n`)
      process.exit(0)
    }
    await setRepairLabels({ add: ['automation/paused'], remove: ['automation/ci-failed', 'automation/repairing'] })
    cancellation.dispose()
    process.stdout.write(`CI repair budget exhausted for pull request #${pullRequestNumber}; no model was started.\n`)
    process.exit(0)
  }
  await writeGovernorRecord({
    version: 1,
    status: 'applied',
    transition: governedTransition,
    subject: { type: governorSubject.type, number: governorSubject.number },
    stateVersion: governorStateVersion,
    observationId: governorObservationId,
  })
} else if (!governorRecords.some(record => record.status === 'applied'
  && (record.transition === governedTransition || (recoveryRequest && record.transition === 'workflow-recovery'))
  && record.subject.type === 'pull-request'
  && record.subject.number === pullRequestNumber
  && record.stateVersion === governorStateVersion)) {
  throw new Error(`Pull request #${pullRequestNumber} has no current controller-attested repair admission`)
}
const priorRun = priorComments.find(comment => authenticatedMarker(comment, marker, markerAuthor))
if (priorRun) {
  const recorded = recordedRepairState(priorRun.body)
  const priorActionRun = recorded.runId
    ? await ghJson(['api', `repos/${repository}/actions/runs/${recorded.runId}`], 'prior repair workflow run')
    : null
  if (interruptedRepairMayRetry(priorRun.body, priorActionRun)) {
    process.stdout.write(`Reclaiming repair request ${marker} after interrupted run ${recorded.runId}.\n`)
  } else {
    process.stdout.write(`DSH already consumed repair request ${marker}; leaving its recorded state for inspection.\n`)
    process.exit(0)
  }
}

const branch = pullRequest.head.ref
const baseBranch = pullRequest.base.ref
if (baseBranch !== defaultBranch) throw new Error(`Pull request base ${baseBranch} is not the configured default branch ${defaultBranch}`)
await upsertStatus('running', branch, explicitRequest
  ? ciRequest
    ? `Failed CI request ${requestId} started a fresh DSH repair session.`
    : `Trusted rework request ${requestId} started a fresh DSH repair session.`
  : 'The blocking Agent review verdict started a fresh repair session.')
await setRepairLabels({
  add: ciRequest ? ['automation/repairing'] : ['automation/review-blocked', 'automation/repairing'],
  remove: ciRequest
    ? ['automation/ci-failed', 'automation/ci-baseline', 'automation/repair-blocked', 'agent/dsh-failed']
    : ['automation/ci-baseline', 'automation/repair-blocked', 'agent/dsh-failed'],
})
const priorReviewCheckIds = ciRequest ? null : await reviewCheckIds()

const jobPath = await mkdtemp(join(runnerTemp, `dsh-repair-${pullRequestNumber}-`))
const checkoutPath = join(jobPath, 'repository')

try {
  await run(config.ghExecutable, [
    'repo', 'clone', repository, checkoutPath, '--', '--filter=blob:none', '--no-checkout',
  ], { env: hostCredentialEnvironment(), tee: true })
  await run(config.gitExecutable, [
    '-C', checkoutPath, 'fetch', '--no-tags', 'origin', baseBranch, branch,
  ], { tee: true })
  await run(config.gitExecutable, [
    '-C', checkoutPath, 'switch', '--track', '-c', branch, `origin/${branch}`,
  ], { tee: true })
  const checkedOutHead = (await run(config.gitExecutable, [
    '-C', checkoutPath, 'rev-parse', 'HEAD',
  ])).stdout.trim()
  if (checkedOutHead !== expectedHead) throw new Error(`Repair checkout is ${checkedOutHead}, expected ${expectedHead}`)

  const prompt = agentWorkPrompt(repairProcedure, {
    kind: 'pull-request-repair',
    repository,
    pullRequestNumber,
    defaultBranch,
    branch,
    expectedHead,
    requestKind: ciRequest ? 'ci' : explicitRequest ? 'explicit' : 'review',
    requestId: requestId || `review-${expectedHead}`,
    ...(ciRequest ? { ciRunId: ciRun.id, ciRunAttempt: ciRun.run_attempt } : {}),
  })

  const workerReceipt = await runAgentWorker({
    config,
    workerId,
    invocation: {
      taskId: `repair-${repository}-${pullRequestNumber}-${expectedHead}-${requestId}`,
      cwd: checkoutPath,
      title: `[Agent: ${workerId}] 修复 PR #${pullRequestNumber} @${expectedHead.slice(0, 7)}`,
      prompt,
      requiredSkill: repairProcedure,
      timeoutMs: 3 * 60 * 60 * 1000,
      signal: cancellation.signal,
      onStarted: ({ sessionId }) => upsertStatus('running', branch, `Visible ${workerId} session: ${sessionId}.`),
    },
    adapters: createAgentAdapters(),
  })

  const baselineReference = ciRequest
    ? ciBaselineIssueFromReceipt({ receipt: workerReceipt, repository })
    : null
  if (baselineReference) {
    const baselineIssue = await ghJson([
      'api', `repos/${repository}/issues/${baselineReference.number}`,
    ], 'reported CI baseline Issue')
    const verifiedBaseline = trustedBaselineIssue({
      issue: baselineIssue,
      repository,
      reference: baselineReference,
      trustedAssociation,
      workflowName: ciWorkflowName,
      branch,
      pullRequestBody: pullRequest.body,
    })
    await setRepairLabels({
      add: ['automation/ci-baseline'],
      remove: ['automation/ci-failed', 'automation/repairing', 'automation/repair-blocked', 'agent/dsh-failed'],
    })
    await upsertStatus('blocked-baseline', branch,
      `Session ${workerReceipt.sessionId} verified the separate default-branch baseline Issue: ${baselineReference.url} (${verifiedBaseline.identity.key}).`)
    process.stdout.write(`DSH identified CI baseline Issue #${baselineReference.number}; the pull request remains unchanged.\n`)
  } else {
    if (workerReceipt.outcome === 'blocked') {
      const blocked = nonBaselineBlockFromReceipt(workerReceipt)
      if (!blocked) throw new Error('DSH reported blocked without a terminal automation result')
      await setRepairLabels({
        add: ['automation/repair-blocked'],
        remove: ['automation/ci-failed', 'automation/repairing', 'agent/dsh-failed'],
      })
      await upsertStatus('blocked', branch,
        `Session ${workerReceipt.sessionId} ended with the valid ${blocked.reason} outcome; no baseline Issue was dispatched.`)
      process.stdout.write(`DSH ended repair for pull request #${pullRequestNumber} with ${blocked.reason}; no retry was scheduled.\n`)
    } else {
      const current = await ghJson(['api', `repos/${repository}/pulls/${pullRequestNumber}`], 'pull request after DSH repair')
      const currentCiRun = ciRequest
        ? await ghJson(['api', `repos/${repository}/actions/runs/${ciRequest.runId}`], 'CI workflow run after repair')
        : null
      if (current.head.sha !== expectedHead) {
        await requestTransportedReview(current)
        await setRepairLabels({ remove: ['automation/review-blocked', 'automation/ci-failed', 'automation/ci-baseline', 'automation/repair-blocked', 'automation/repairing', 'agent/dsh-failed'] })
        await upsertStatus('complete', branch, `Session ${workerReceipt.sessionId} advanced the pull request to ${current.head.sha}; the trusted Profile workflow requested an exact-head review.`)
        process.stdout.write(`Pull request #${pullRequestNumber} advanced to ${current.head.sha}; the stale repair is complete.\n`)
      } else if (ciRequest && trustedCiRerunSuccess({
        priorRun: ciRun,
        currentRun: currentCiRun,
        pullRequestNumber,
        expectedHead,
        workflowName: ciWorkflowName,
      })) {
        await setRepairLabels({ remove: ['automation/ci-failed', 'automation/ci-baseline', 'automation/repair-blocked', 'automation/repairing', 'agent/dsh-failed'] })
        await upsertStatus('complete', branch, `Session ${workerReceipt.sessionId} reran the same exact-head CI workflow successfully on attempt ${currentCiRun.run_attempt}.`)
        process.stdout.write(`${workerId} repaired CI for pull request #${pullRequestNumber} by a successful exact-head rerun.\n`)
      } else if (!ciRequest && await sameHeadRereviewRequested(current, priorReviewCheckIds)) {
        await setRepairLabels({ remove: ['automation/review-blocked', 'automation/repair-blocked', 'automation/repairing', 'agent/dsh-failed'] })
        await upsertStatus('complete', branch, `Session ${workerReceipt.sessionId} posted a technical rebuttal and requested one same-head review.`)
        process.stdout.write(`${workerId} requested a same-head rereview for pull request #${pullRequestNumber}.\n`)
      } else {
        throw new Error('DSH exited successfully without advancing the head or proving the documented same-head completion')
      }
    }
  }
} catch (error) {
  const failureClass = classifyAgentFailure(error)
  await upsertStatus('failed', branch, `The repair run failed: ${String(error.message).slice(0, 1000)}`, failureClass)
    .catch(() => undefined)
  await setRepairLabels({
    add: ciRequest ? ['agent/dsh-failed'] : ['automation/review-blocked', 'agent/dsh-failed'],
    remove: ['automation/ci-failed', 'automation/ci-baseline', 'automation/repair-blocked', 'automation/repairing'],
  })
  throw error
} finally {
  cancellation.dispose()
  await removeJobDirectory(runnerTemp, jobPath)
}
