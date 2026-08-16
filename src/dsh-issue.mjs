import { mkdtemp } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import {
  hostCredentialEnvironment,
  githubLogin,
  authenticatedMarker,
  authorizedIssueBranch,
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
import { createAgentAdapters } from './agent-adapters.mjs'
import { runAgentWorker } from './agent-worker.mjs'
import { agentWorkPrompt } from './agent-work-result.mjs'
import { openAgentWorkDependencies, resolveAgentWorkDispatch } from './agent-work.mjs'
import { classifyAgentFailure } from './failure-classification.mjs'
import { subjectStateVersion, workflowStageTransition } from './governor-policy.mjs'
import { GOVERNOR_WORKFLOW_PATHS, issueGovernorSubject, trustedGovernorRecords } from './governor-state.mjs'
import { loadTrustedWorkflowProfile, resolveWorkflowStage } from './workflow-profile.mjs'
import { requireEligibleWorkflowStage } from './workflow-runtime.mjs'
import { parseAgentWorkRequest } from './work-request.mjs'

const repository = requiredEnv('TARGET_REPOSITORY')
const workRequest = parseAgentWorkRequest(parseJson(requiredEnv('WORK_REQUEST_JSON'), 'WorkRequest'))
const issueNumber = workRequest.subject.number
const issueRequestId = workRequest.requestId
const runnerTemp = resolve(requiredEnv('RUNNER_TEMP'))
const config = await loadConfig()
const cancellation = processCancellationSignal()
const defaultBranch = requiredEnv('DEFAULT_BRANCH')
const markerAuthor = githubLogin(config)
const marker = '<!-- agent-worker-run -->'
const governorTrust = {
  repository,
  controllerRepository: requiredEnv('CONTROLLER_REPOSITORY'),
  workflowPaths: GOVERNOR_WORKFLOW_PATHS,
}

if (!config.repositories.includes(repository)) throw new Error(`${repository} is not in the runner allowlist`)
if (workRequest.repository !== repository || workRequest.subject.type !== 'issue') {
  throw new Error('WorkRequest does not identify an Issue in the target repository')
}

async function ghJson(args, description) {
  const result = await run(config.ghExecutable, args, { env: hostCredentialEnvironment() })
  return parseJson(result.stdout, description)
}

async function targetProfile() {
  return loadTrustedWorkflowProfile({
    repository,
    revision: workRequest.revision.base,
    profileId: workRequest.profileId,
    loadContent: async ({ path, revision }) => {
      const content = await ghJson([
        'api', '--method', 'GET', `repos/${repository}/contents/${path}`, '-f', `ref=${revision}`,
      ], `Profile ${workRequest.profileId} at ${revision}`)
      if (content?.encoding !== 'base64' || typeof content.content !== 'string') {
        throw new Error(`Profile ${workRequest.profileId} is not a GitHub file`)
      }
      return Buffer.from(content.content.replace(/\s/g, ''), 'base64').toString('utf8')
    },
  })
}

await verifyGithubIdentity({ config })

async function upsertStatus(body) {
  const comments = (await ghJson([
    'api', `repos/${repository}/issues/${issueNumber}/comments?per_page=100`, '--paginate', '--slurp',
  ], 'Issue comments')).flat()
  const prior = comments.find(comment => authenticatedMarker(comment, marker, markerAuthor))
  if (prior) {
    await run(config.ghExecutable, [
      'api', '--method', 'PATCH', `repos/${repository}/issues/comments/${prior.id}`, '-f', `body=${body}`,
    ], { env: hostCredentialEnvironment() })
  } else {
    await run(config.ghExecutable, [
      'issue', 'comment', String(issueNumber), '--repo', repository, '--body', body,
    ], { env: hostCredentialEnvironment() })
  }
}

function statusBody(status, branch, detail, failureClass) {
  return [
    marker,
    '### Agent worker run',
    '',
    `- Status: **${status}**`,
    `- Branch: \`${branch}\``,
    `- Run: ${requiredEnv('RUN_URL')}`,
    ...(failureClass ? [`- Failure class: \`${failureClass}\``] : []),
    `- Detail: ${detail}`,
    '',
    '_The selected change Worker owns implementation, validation, commits, pushes, and the pull request._',
  ].join('\n')
}

const issue = await ghJson(['api', `repos/${repository}/issues/${issueNumber}`], 'Issue')
if (issue.state !== 'open') throw new Error(`Issue #${issueNumber} is not open`)
if (!trustedAssociation(issue.author_association)) {
  throw new Error(`Issue #${issueNumber} has untrusted author association ${issue.author_association}`)
}
if (!issue.labels?.some(label => label.name === 'agent/dsh')) {
  throw new Error(`Issue #${issueNumber} no longer has the exact agent/dsh label`)
}
if (issue.labels?.some(label => label.name === 'automation/paused')) {
  throw new Error(`Issue #${issueNumber} is paused and requires an authorized resume`)
}
const defaultHead = await ghJson([
  'api', `repos/${repository}/commits/${encodeURIComponent(defaultBranch)}`,
], `default branch ${defaultBranch}`)
if (defaultHead?.sha !== workRequest.revision.base || workRequest.revision.head !== workRequest.revision.base) {
  throw new Error(`WorkRequest base ${workRequest.revision.base} is stale for ${defaultBranch}`)
}
const profile = await targetProfile()
if (profile.definitionHash !== workRequest.definitionHash) {
  throw new Error('WorkRequest Profile hash does not match the trusted target revision')
}
const stage = resolveWorkflowStage(
  profile.definition,
  workRequest.workflowId,
  workRequest.stageId,
  'worker',
)
requireEligibleWorkflowStage(profile.definition, workRequest.workflowId, workRequest.stageId, [])
if (stage.role !== workRequest.role) throw new Error('WorkRequest role does not match the trusted Stage')
const workerId = resolveRepositoryWorker(config, repository, stage.role)
const admissionComments = (await ghJson([
  'api', `repos/${repository}/issues/${issueNumber}/comments?per_page=100`, '--paginate', '--slurp',
], 'Issue governor records')).flat()
const governorRecords = await trustedGovernorRecords({
  comments: admissionComments,
  trust: governorTrust,
  loadRun: runId => ghJson(['api', `repos/${repository}/actions/runs/${runId}`], `governor workflow run ${runId}`),
})
const governorSubject = issueGovernorSubject(issue)
const governorStateVersion = subjectStateVersion(governorSubject)
if (!governorRecords.some(record => record.status === 'applied'
  && record.transition === workflowStageTransition(workRequest)
  && record.subject.type === 'issue'
  && record.subject.number === issueNumber
  && record.stateVersion === governorStateVersion)) {
  throw new Error(`Issue #${issueNumber} has no current controller-attested work admission`)
}

const agentDispatch = resolveAgentWorkDispatch(
  issue.body || '',
  issueNumber,
  issueRequestId,
  workRequest.definitionHash,
)
const agentWork = agentDispatch?.work
if (!agentDispatch || agentWork.profile !== workRequest.profileId || agentWork.workflow !== workRequest.workflowId) {
  throw new Error(`Issue #${issueNumber} no longer selects the dispatched Profile workflow`)
}
const branch = authorizedIssueBranch(
  issueNumber,
  agentDispatch.branch,
  defaultBranch,
)
const existing = await ghJson([
  'pr', 'list', '--repo', repository, '--state', 'open', '--head', branch,
  '--json', 'number,body,headRefName,baseRefName,url',
], 'existing pull requests')
const closesIssue = pr => new RegExp(`\\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\\s+#${issueNumber}\\b`, 'i')
  .test(pr.body || '')
const validExisting = existing.find(pr => pr.headRefName === branch
  && pr.baseRefName === defaultBranch
  && closesIssue(pr))
if (validExisting) {
  await upsertStatus(statusBody('complete', branch, `Existing pull request: ${validExisting.url}`))
  process.stdout.write(`Issue #${issueNumber} already has ${validExisting.url}\n`)
  process.exit(0)
}
if (existing.length > 0) {
  throw new Error(`Issue #${issueNumber} branch ${branch} is already used by another open pull request`)
}

if (agentWork) {
  const openDependencies = await openAgentWorkDependencies(agentWork, number => ghJson([
    'api', `repos/${repository}/issues/${number}`,
  ], `Issue dependency #${number}`))
  if (openDependencies.length > 0) {
    await upsertStatus(statusBody('waiting', branch, `Open dependencies: ${openDependencies.map(number => `#${number}`).join(', ')}`))
    process.stdout.write(`Issue #${issueNumber} is waiting for ${openDependencies.map(number => `#${number}`).join(', ')}.\n`)
    process.exit(0)
  }
}

const jobPath = await mkdtemp(join(runnerTemp, `dsh-issue-${issueNumber}-`))
const checkoutPath = join(jobPath, 'repository')

try {
  for (const label of ['agent/dsh-blocked', 'agent/dsh-failed']) {
    await run(config.ghExecutable, [
      'issue', 'edit', String(issueNumber), '--repo', repository, '--remove-label', label,
    ], { env: hostCredentialEnvironment() }).catch(() => undefined)
  }
  await upsertStatus(statusBody('running', branch, 'The GitHub event started a fresh DSH session.'))
  await run(config.ghExecutable, [
    'repo', 'clone', repository, checkoutPath, '--', '--filter=blob:none', '--no-checkout',
  ], { env: hostCredentialEnvironment(), tee: true })
  await run(config.gitExecutable, [
    '-C', checkoutPath, 'fetch', '--no-tags', 'origin', defaultBranch,
  ], { tee: true })
  await run(config.gitExecutable, [
    '-C', checkoutPath, 'fetch', '--no-tags', 'origin', branch,
  ], { tee: true }).catch(() => undefined)

  const remoteBranch = await run(config.gitExecutable, [
    '-C', checkoutPath, 'show-ref', '--verify', '--quiet', `refs/remotes/origin/${branch}`,
  ]).then(() => true, () => false)
  if (remoteBranch) {
    await run(config.gitExecutable, [
      '-C', checkoutPath, 'switch', '--track', '-c', branch, `origin/${branch}`,
    ], { tee: true })
  } else {
    await run(config.gitExecutable, [
      '-C', checkoutPath, 'switch', '-c', branch, `origin/${defaultBranch}`,
    ], { tee: true })
  }

  const prompt = agentWorkPrompt(stage.procedure, {
    kind: 'issue',
    repository,
    issueNumber,
    defaultBranch,
    branch,
    ...(agentWork ? { work: agentWork } : {}),
  })

  const workerReceipt = await runAgentWorker({
    config,
    workerId,
    invocation: {
      taskId: `issue-${repository}-${issueNumber}-${issueRequestId}`,
      cwd: checkoutPath,
      title: `[Agent: ${workerId}] 执行 Issue #${issueNumber}`,
      prompt,
      requiredSkill: stage.procedure,
      timeoutMs: 3 * 60 * 60 * 1000,
      signal: cancellation.signal,
      onStarted: ({ sessionId }) => upsertStatus(statusBody('running', branch, `Visible ${workerId} session: ${sessionId}.`)),
    },
    adapters: createAgentAdapters(),
  })

  if (workerReceipt.outcome === 'blocked') {
    await run(config.ghExecutable, [
      'label', 'create', 'agent/dsh-blocked', '--repo', repository,
      '--description', 'DSH reached a valid terminal block without producing a pull request', '--color', 'B60205',
    ], { env: hostCredentialEnvironment() }).catch(() => undefined)
    await run(config.ghExecutable, [
      'issue', 'edit', String(issueNumber), '--repo', repository,
      '--remove-label', 'agent/dsh', '--add-label', 'agent/dsh-blocked',
    ], { env: hostCredentialEnvironment() })
    await upsertStatus(statusBody('blocked', branch,
      `Session ${workerReceipt.sessionId} reached a valid terminal block: ${workerReceipt.detail}`))
    process.stdout.write(`${workerId} ended Issue #${issueNumber} as blocked; no retry was scheduled.\n`)
  } else {
    if (workerReceipt.outcome !== 'completed') {
      throw new Error(`DSH worker ended Issue #${issueNumber} with ${workerReceipt.outcome}`)
    }
    const pullRequests = await ghJson([
      'pr', 'list', '--repo', repository, '--state', 'open', '--head', branch,
      '--json', 'number,body,headRefName,baseRefName,url,headRefOid',
    ], 'resulting pull requests')
    const pullRequest = pullRequests.find(pr => pr.headRefName === branch
      && pr.baseRefName === defaultBranch
      && closesIssue(pr))
    if (!pullRequest) {
      throw new Error(`DSH exited successfully but did not create an open ${branch} -> ${defaultBranch} pull request that closes #${issueNumber}`)
    }

    const remoteHead = (await run(config.gitExecutable, [
      'ls-remote', '--heads', 'origin', `refs/heads/${branch}`,
    ], { cwd: checkoutPath })).stdout.trim().split(/\s+/)[0]
    if (!remoteHead || remoteHead !== pullRequest.headRefOid) {
      throw new Error(`Pull request head ${pullRequest.headRefOid} does not match remote branch head ${remoteHead || '<missing>'}`)
    }

    await upsertStatus(statusBody('complete', branch, `Session ${workerReceipt.sessionId} produced a pull request for independent review: ${pullRequest.url}`))
    process.stdout.write(`${workerId} produced ${pullRequest.url} at ${pullRequest.headRefOid}\n`)
  }
} catch (error) {
  const failureClass = classifyAgentFailure(error)
  await upsertStatus(statusBody('failed', branch, `The run failed: ${String(error.message).slice(0, 1000)}`, failureClass))
    .catch(() => undefined)
  await run(config.ghExecutable, [
    'issue', 'edit', String(issueNumber), '--repo', repository,
    '--remove-label', 'agent/dsh', '--remove-label', 'agent/dsh-blocked',
    '--add-label', 'agent/dsh-failed',
  ], { env: hostCredentialEnvironment() }).catch(() => undefined)
  throw error
} finally {
  cancellation.dispose()
  await removeJobDirectory(runnerTemp, jobPath)
}
