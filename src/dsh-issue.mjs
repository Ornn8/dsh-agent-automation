import { mkdtemp } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import {
  hostCredentialEnvironment,
  githubLogin,
  issueBranch,
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
import { DSH_ISSUE_SKILL, dshWorkPrompt } from './dsh-work.mjs'

const repository = requiredEnv('TARGET_REPOSITORY')
const issueNumber = Number.parseInt(requiredEnv('ISSUE_NUMBER'), 10)
const issueRequestId = requiredEnv('ISSUE_REQUEST_ID')
const runnerTemp = resolve(requiredEnv('RUNNER_TEMP'))
const config = await loadConfig()
const workerId = resolveRepositoryWorker(config, repository, requiredEnv('AGENT_ROLE'))
const cancellation = processCancellationSignal()
const defaultBranch = requiredEnv('DEFAULT_BRANCH')
const markerAuthor = githubLogin(config)
const marker = '<!-- dsh-agent-run -->'

if (!config.repositories.includes(repository)) throw new Error(`${repository} is not in the runner allowlist`)
if (!Number.isSafeInteger(issueNumber) || issueNumber < 1) {
  throw new Error(`Invalid ISSUE_NUMBER: ${process.env.ISSUE_NUMBER}`)
}

async function ghJson(args, description) {
  const result = await run(config.ghExecutable, args, { env: hostCredentialEnvironment() })
  return parseJson(result.stdout, description)
}

await verifyGithubIdentity({ config })

async function upsertStatus(body) {
  const comments = await ghJson([
    'api', `repos/${repository}/issues/${issueNumber}/comments`, '--paginate',
  ], 'Issue comments')
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

function statusBody(status, branch, detail) {
  return [
    marker,
    '### DSH agent run',
    '',
    `- Status: **${status}**`,
    `- Branch: \`${branch}\``,
    `- Run: ${requiredEnv('RUN_URL')}`,
    `- Detail: ${detail}`,
    '',
    '_DSH owns implementation, validation, commits, pushes, and the pull request._',
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

const branch = authorizedIssueBranch(
  issueNumber,
  issueBranch(issue.body || '', /^\[BUG\]\s+/i.test(issue.title || '') ? { number: issueNumber } : undefined),
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

const jobPath = await mkdtemp(join(runnerTemp, `dsh-issue-${issueNumber}-`))
const checkoutPath = join(jobPath, 'repository')

try {
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

  const prompt = dshWorkPrompt(DSH_ISSUE_SKILL, {
    kind: 'issue',
    repository,
    issueNumber,
    defaultBranch,
    branch,
  })

  const workerReceipt = await runAgentWorker({
    config,
    workerId,
    invocation: {
      taskId: `issue-${repository}-${issueNumber}-${issueRequestId}`,
      cwd: checkoutPath,
      title: `[Agent: ${workerId}] 执行 Issue #${issueNumber}`,
      prompt,
      requiredSkill: DSH_ISSUE_SKILL,
      timeoutMs: 3 * 60 * 60 * 1000,
      signal: cancellation.signal,
      onStarted: ({ sessionId }) => upsertStatus(statusBody('running', branch, `Visible ${workerId} session: ${sessionId}.`)),
    },
    adapters: createAgentAdapters(),
  })

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
} catch (error) {
  await upsertStatus(statusBody('failed', branch, `The run failed: ${String(error.message).slice(0, 1000)}`))
    .catch(() => undefined)
  await run(config.ghExecutable, [
    'issue', 'edit', String(issueNumber), '--repo', repository,
    '--remove-label', 'agent/dsh', '--add-label', 'agent/dsh-failed',
  ], { env: hostCredentialEnvironment() }).catch(() => undefined)
  throw error
} finally {
  cancellation.dispose()
  await removeJobDirectory(runnerTemp, jobPath)
}
