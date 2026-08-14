import { mkdtemp } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import {
  hostCredentialEnvironment,
  issueBranch,
  loadConfig,
  parseJson,
  removeJobDirectory,
  requiredEnv,
  run,
  trustedAssociation,
} from './common.mjs'
import { runDshWebSession } from './dsh-web-session.mjs'

const repository = requiredEnv('TARGET_REPOSITORY')
const issueNumber = Number.parseInt(requiredEnv('ISSUE_NUMBER'), 10)
const runnerTemp = resolve(requiredEnv('RUNNER_TEMP'))
const config = await loadConfig()
const marker = '<!-- dsh-agent-run -->'

if (!config.repositories.includes(repository)) throw new Error(`${repository} is not in the runner allowlist`)
if (!Number.isSafeInteger(issueNumber) || issueNumber < 1) {
  throw new Error(`Invalid ISSUE_NUMBER: ${process.env.ISSUE_NUMBER}`)
}

async function ghJson(args, description) {
  const result = await run(config.ghExecutable, args, { env: hostCredentialEnvironment() })
  return parseJson(result.stdout, description)
}

async function upsertStatus(body) {
  const comments = await ghJson([
    'api', `repos/${repository}/issues/${issueNumber}/comments`, '--paginate',
  ], 'Issue comments')
  const prior = comments.find(comment => comment.body?.includes(marker))
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

const branch = issueBranch(issue.body || '', /^\[BUG\]\s+/i.test(issue.title || '')
  ? { number: issueNumber }
  : undefined)
const existing = await ghJson([
  'pr', 'list', '--repo', repository, '--state', 'open', '--head', branch,
  '--json', 'number,body,headRefName,baseRefName,url',
], 'existing pull requests')
const closesIssue = pr => new RegExp(`\\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\\s+#${issueNumber}\\b`, 'i')
  .test(pr.body || '')
const validExisting = existing.find(pr => pr.headRefName === branch
  && pr.baseRefName === 'master'
  && closesIssue(pr))
if (validExisting) {
  await upsertStatus(statusBody('complete', branch, `Existing pull request: ${validExisting.url}`))
  process.stdout.write(`Issue #${issueNumber} already has ${validExisting.url}\n`)
  process.exit(0)
}

const jobPath = await mkdtemp(join(runnerTemp, `dsh-issue-${issueNumber}-`))
const checkoutPath = join(jobPath, 'repository')

try {
  await upsertStatus(statusBody('running', branch, 'The GitHub event started a fresh DSH session.'))
  await run(config.ghExecutable, [
    'repo', 'clone', repository, checkoutPath, '--', '--filter=blob:none', '--no-checkout',
  ], { env: hostCredentialEnvironment(), tee: true })
  await run(config.gitExecutable, [
    '-C', checkoutPath, 'fetch', '--no-tags', 'origin', 'master',
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
      '-C', checkoutPath, 'switch', '-c', branch, 'origin/master',
    ], { tee: true })
  }

  const prompt = `Execute GitHub Issue #${issueNumber} in ${repository}.

GitHub is the only coordination channel. Read the live Issue, its comments, the repository instructions, and the current master branch before deciding what to do. Use English for every GitHub comment, commit, branch, and pull request field.

You own the implementation end to end:
1. If no valid claim exists, comment exactly \`CLAIMED: starting ${branch}\` on Issue #${issueNumber}.
2. Work only on branch \`${branch}\` in the current checkout. Do not delegate implementation to Codex or another agent.
3. Implement the Issue completely, add required tests and documentation, and run the repository checks appropriate to the actual diff.
4. Commit and push the work yourself.
5. Open or update one pull request to \`master\`; its body must contain \`Closes #${issueNumber}\` and must report only checks actually run.
6. If you cannot complete the work, leave one English \`BLOCKED:\` Issue comment with concrete evidence and do not claim success.

Do not wait for another local process or WebUI session. Finish only after the pull request exists at the declared branch and exact pushed head, or after posting the BLOCKED handoff.`

  const dshSession = await runDshWebSession({
    baseUrl: config.dshWebBaseUrl,
    cwd: checkoutPath,
    title: `[DSH] 执行 Issue #${issueNumber}`,
    prompt: `${prompt}\n\nFinish this local DSH session with a concise Chinese report. Keep all GitHub-visible content in English.`,
    onCreated: ({ sessionId }) => upsertStatus(statusBody('running', branch, `Visible DSH session: ${sessionId}.`)),
  })

  const pullRequests = await ghJson([
    'pr', 'list', '--repo', repository, '--state', 'open', '--head', branch,
    '--json', 'number,body,headRefName,baseRefName,url,headRefOid',
  ], 'resulting pull requests')
  const pullRequest = pullRequests.find(pr => pr.headRefName === branch
    && pr.baseRefName === 'master'
    && closesIssue(pr))
  if (!pullRequest) {
    throw new Error(`DSH exited successfully but did not create an open ${branch} -> master pull request that closes #${issueNumber}`)
  }

  const remoteHead = (await run(config.gitExecutable, [
    'ls-remote', '--heads', 'origin', `refs/heads/${branch}`,
  ], { cwd: checkoutPath })).stdout.trim().split(/\s+/)[0]
  if (!remoteHead || remoteHead !== pullRequest.headRefOid) {
    throw new Error(`Pull request head ${pullRequest.headRefOid} does not match remote branch head ${remoteHead || '<missing>'}`)
  }

  await upsertStatus(statusBody('complete', branch, `Session ${dshSession.sessionId} produced a pull request for independent review: ${pullRequest.url}`))
  process.stdout.write(`DSH produced ${pullRequest.url} at ${pullRequest.headRefOid}\n`)
} catch (error) {
  await upsertStatus(statusBody('failed', branch, `The run failed: ${String(error.message).slice(0, 1000)}`))
    .catch(() => undefined)
  await run(config.ghExecutable, [
    'issue', 'edit', String(issueNumber), '--repo', repository,
    '--remove-label', 'agent/dsh', '--add-label', 'agent/dsh-failed',
  ], { env: hostCredentialEnvironment() }).catch(() => undefined)
  throw error
} finally {
  await removeJobDirectory(runnerTemp, jobPath)
}
