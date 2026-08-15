import { mkdtemp } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import {
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
  explicitReworkCommand,
  trustedCiFailure,
} from './dispatch-policy.mjs'
import { createAgentAdapters } from './agent-adapters.mjs'
import { runAgentWorker } from './agent-worker.mjs'
import {
  automaticRepairAttemptCount,
  automaticRepairLimitReached,
  interruptedRepairMayRetry,
  MAX_AUTOMATIC_REPAIR_ATTEMPTS,
  recordedRepairState,
} from './repair-state.mjs'
import {
  ciBaselineIssueFromReceipt,
  nonBaselineBlockFromReceipt,
  trustedBaselineIssue,
} from './baseline-issue.mjs'
import { isReviewRepairRequestId } from './work-request.mjs'
import { AGENT_REPAIR_SKILL, agentWorkPrompt } from './agent-work-result.mjs'

const repository = requiredEnv('TARGET_REPOSITORY')
const pullRequestNumber = Number.parseInt(requiredEnv('PR_NUMBER'), 10)
const expectedHead = requiredEnv('HEAD_SHA')
const requestId = process.env.REPAIR_REQUEST_ID?.trim() || ''
const ciWorkflowName = process.env.CI_WORKFLOW_NAME?.trim() || ''
const runnerTemp = resolve(requiredEnv('RUNNER_TEMP'))
const config = await loadConfig()
const workerId = resolveRepositoryWorker(config, repository, requiredEnv('AGENT_ROLE'))
const cancellation = processCancellationSignal()
const defaultBranch = requiredEnv('DEFAULT_BRANCH')
const markerAuthor = githubLogin(config)
const controllerSha = requiredEnv('CONTROLLER_SHA').toLowerCase()
if (requestId && !/^[A-Za-z0-9._-]{1,100}$/.test(requestId)) throw new Error('Invalid REPAIR_REQUEST_ID')
if (!/^[0-9a-f]{40}$/.test(controllerSha)) throw new Error('CONTROLLER_SHA must be a full lowercase commit SHA')
const marker = requestId
  ? `<!-- dsh-review-repair:${controllerSha}:${expectedHead}:${requestId} -->`
  : `<!-- dsh-review-repair:${controllerSha}:${expectedHead} -->`
const ciRequest = ciRepairRequest(requestId)
const explicitRequest = Boolean(ciRequest)
  || (!isReviewRepairRequestId(requestId, expectedHead)
    && requestId.startsWith('comment-'))
const repairClass = ciRequest
  ? 'automatic-ci'
  : explicitRequest
    ? 'explicit-human'
    : 'automatic-review'
const automaticRepair = repairClass !== 'explicit-human'

if (!config.repositories.includes(repository)) throw new Error(`${repository} is not in the runner allowlist`)
if (!Number.isSafeInteger(pullRequestNumber) || pullRequestNumber < 1) {
  throw new Error(`Invalid PR_NUMBER: ${process.env.PR_NUMBER}`)
}

async function ghJson(args, description) {
  const result = await run(config.ghExecutable, args, { env: hostCredentialEnvironment() })
  return parseJson(result.stdout, description)
}

await verifyGithubIdentity({ config })

async function upsertStatus(status, branch, detail) {
  const body = [
    marker,
    ciRequest ? '### DSH CI repair' : '### DSH review repair',
    '',
    `- Status: **${status}**`,
    `- Controller SHA: \`${controllerSha}\``,
    `- Repair class: \`${repairClass}\``,
    `- Reviewed head: \`${expectedHead}\``,
    `- Branch: \`${branch}\``,
    `- Run: ${requiredEnv('RUN_URL')}`,
    `- Detail: ${detail}`,
    '',
    '_DSH owns the technical response and any implementation changes._',
  ].join('\n')
  const comments = await ghJson([
    'api', `repos/${repository}/issues/${pullRequestNumber}/comments`, '--paginate',
  ], 'pull request comments')
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
    ['automation/review-blocked', 'Codex found a blocking defect at the current PR head', 'B60205'],
    ['automation/ci-failed', 'A failed CI run requires DSH repair at the current PR head', 'D93F0B'],
    ['automation/ci-baseline', 'The failed CI condition is tracked by a separate default-branch Issue', '1D76DB'],
    ['automation/repair-blocked', 'DSH ended this repair with a valid blocked outcome', 'B60205'],
    ['automation/repairing', 'DSH is addressing the current blocking review', 'FBCA04'],
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

const pullRequest = await ghJson(['api', `repos/${repository}/pulls/${pullRequestNumber}`], 'pull request')
if (pullRequest.state !== 'open') throw new Error(`Pull request #${pullRequestNumber} is not open`)
if (pullRequest.draft) throw new Error(`Pull request #${pullRequestNumber} is still a draft`)
if (pullRequest.head.repo?.full_name !== repository) throw new Error('Fork pull requests cannot reach the DSH repair agent')
if (pullRequest.head.sha !== expectedHead) throw new Error('The pull request head changed before DSH repair started')
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

const priorComments = await ghJson([
  'api', `repos/${repository}/issues/${pullRequestNumber}/comments`, '--paginate',
], 'pull request comments')
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
if (automaticRepair) {
  const automaticAttempts = automaticRepairAttemptCount(priorComments, {
    authorLogin: markerAuthor,
    controllerSha,
  })
  if (automaticRepairLimitReached(automaticAttempts)) {
    await upsertStatus('dead-letter', branch,
      `Automatic repair limit reached: ${MAX_AUTOMATIC_REPAIR_ATTEMPTS} attempts under controller ${controllerSha}. A trusted explicit rework command may still request repair.`)
    await setRepairLabels({
      add: ['agent/dsh-failed'],
      remove: ['automation/review-blocked', 'automation/ci-failed', 'automation/ci-baseline', 'automation/repair-blocked', 'automation/repairing'],
    })
    cancellation.dispose()
    process.stdout.write(`Automatic repair limit reached for pull request #${pullRequestNumber}; wrote dead-letter status without starting a model.\n`)
    process.exit(0)
  }
}
await upsertStatus('running', branch, explicitRequest
  ? ciRequest
    ? `Failed CI request ${requestId} started a fresh DSH repair session.`
    : `Trusted rework request ${requestId} started a fresh DSH repair session.`
  : 'The blocking Codex verdict started a fresh DSH repair session.')
await setRepairLabels({
  add: ciRequest ? ['automation/repairing'] : ['automation/review-blocked', 'automation/repairing'],
  remove: ciRequest
    ? ['automation/ci-failed', 'automation/ci-baseline', 'automation/repair-blocked', 'agent/dsh-failed']
    : ['automation/ci-baseline', 'automation/repair-blocked', 'agent/dsh-failed'],
})

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

  const prompt = agentWorkPrompt(AGENT_REPAIR_SKILL, {
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
      requiredSkill: AGENT_REPAIR_SKILL,
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
      if (current.head.sha !== expectedHead) {
        await setRepairLabels({ remove: ['automation/review-blocked', 'automation/ci-failed', 'automation/ci-baseline', 'automation/repair-blocked', 'automation/repairing', 'agent/dsh-failed'] })
        await upsertStatus('complete', branch, `Session ${workerReceipt.sessionId} advanced the pull request to ${current.head.sha}; GitHub will review the newer head.`)
        process.stdout.write(`Pull request #${pullRequestNumber} advanced to ${current.head.sha}; the stale repair is complete.\n`)
      } else if (!ciRequest && current.labels.some(label => label.name === 'automation/review-ready')) {
        await setRepairLabels({ remove: ['automation/review-blocked', 'automation/repair-blocked', 'automation/repairing', 'agent/dsh-failed'] })
        await upsertStatus('complete', branch, `Session ${workerReceipt.sessionId} posted a technical rebuttal and requested one same-head review.`)
        process.stdout.write(`${workerId} requested a same-head rereview for pull request #${pullRequestNumber}.\n`)
      } else {
        throw new Error('DSH exited successfully without advancing the head or requesting the documented same-head rereview')
      }
    }
  }
} catch (error) {
  await upsertStatus('failed', branch, `The repair run failed: ${String(error.message).slice(0, 1000)}`)
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
