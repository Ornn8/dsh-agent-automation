import { mkdtemp } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import {
  hostCredentialEnvironment,
  loadConfig,
  parseJson,
  removeJobDirectory,
  requiredEnv,
  run,
  trustedAssociation,
} from './common.mjs'
import { explicitReworkCommand } from './dispatch-policy.mjs'

const repository = requiredEnv('TARGET_REPOSITORY')
const pullRequestNumber = Number.parseInt(requiredEnv('PR_NUMBER'), 10)
const expectedHead = requiredEnv('HEAD_SHA')
const requestId = process.env.REPAIR_REQUEST_ID?.trim() || ''
const runnerTemp = resolve(requiredEnv('RUNNER_TEMP'))
const config = await loadConfig()
if (requestId && !/^[A-Za-z0-9._-]{1,100}$/.test(requestId)) throw new Error('Invalid REPAIR_REQUEST_ID')
const marker = requestId
  ? `<!-- dsh-review-repair:${expectedHead}:${requestId} -->`
  : `<!-- dsh-review-repair:${expectedHead} -->`
const explicitCommentRequest = requestId.startsWith('comment-')

if (!config.repositories.includes(repository)) throw new Error(`${repository} is not in the runner allowlist`)
if (!Number.isSafeInteger(pullRequestNumber) || pullRequestNumber < 1) {
  throw new Error(`Invalid PR_NUMBER: ${process.env.PR_NUMBER}`)
}

async function ghJson(args, description) {
  const result = await run(config.ghExecutable, args, { env: hostCredentialEnvironment() })
  return parseJson(result.stdout, description)
}

async function upsertStatus(status, branch, detail) {
  const body = [
    marker,
    '### DSH review repair',
    '',
    `- Status: **${status}**`,
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
  const prior = comments.find(comment => comment.body?.includes(marker))
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

const pullRequest = await ghJson(['api', `repos/${repository}/pulls/${pullRequestNumber}`], 'pull request')
if (pullRequest.state !== 'open') throw new Error(`Pull request #${pullRequestNumber} is not open`)
if (pullRequest.draft) throw new Error(`Pull request #${pullRequestNumber} is still a draft`)
if (pullRequest.head.repo?.full_name !== repository) throw new Error('Fork pull requests cannot reach the DSH repair agent')
if (pullRequest.head.sha !== expectedHead) throw new Error('The pull request head changed before DSH repair started')
if (explicitCommentRequest) {
  const commentId = Number.parseInt(requestId.slice('comment-'.length), 10)
  if (!Number.isSafeInteger(commentId) || commentId < 1) throw new Error('Invalid comment repair request id')
  const comment = await ghJson(['api', `repos/${repository}/issues/comments/${commentId}`], 'rework comment')
  if (!comment.issue_url?.endsWith(`/issues/${pullRequestNumber}`)) {
    throw new Error('Rework comment does not belong to this pull request')
  }
  if (!trustedAssociation(comment.author_association)) {
    throw new Error(`Untrusted rework comment association ${comment.author_association}`)
  }
  if (!explicitReworkCommand(comment.body)) throw new Error('Comment is not an explicit DSH rework command')
}
if (!explicitCommentRequest && !pullRequest.labels.some(label => label.name === 'automation/review-blocked')) {
  throw new Error('The pull request no longer has the automation/review-blocked label')
}

const priorComments = await ghJson([
  'api', `repos/${repository}/issues/${pullRequestNumber}/comments`, '--paginate',
], 'pull request comments')
const priorRun = priorComments.find(comment => comment.body?.includes(marker)
  && comment.body.includes('- Status: **complete**'))
if (priorRun) {
  process.stdout.write(`DSH already completed a response for ${expectedHead}; leaving the repeated block for human inspection.\n`)
  process.exit(0)
}

const branch = pullRequest.head.ref
const baseBranch = pullRequest.base.ref
await upsertStatus('running', branch, explicitCommentRequest
  ? `Trusted rework comment ${requestId} started a fresh DSH repair session.`
  : 'The blocking Codex verdict started a fresh DSH repair session.')
if (!explicitCommentRequest) {
  await run(config.ghExecutable, [
    'pr', 'edit', String(pullRequestNumber), '--repo', repository,
    '--remove-label', 'automation/review-blocked',
  ], { env: hostCredentialEnvironment() })
}

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

  const requestDescription = explicitCommentRequest
    ? `the explicit trusted rework request ${requestId}`
    : 'the blocking Codex review and every unresolved trusted blocking comment'
  const prompt = `Address ${requestDescription} on ${repository} pull request #${pullRequestNumber} at exact head ${expectedHead}.

GitHub is the only coordination channel. Read the live pull request, all trusted review and conversation comments, its linked Issue, all repository instructions, and the exact \`${baseBranch}...${branch}\` diff before deciding what to do. When a \`codex-review:${expectedHead}\` marker exists, treat it as the automated verdict; an explicit \`comment-*\` request is a separate instruction on the same head. Use English for every GitHub comment, commit, and pull request update.

You own the technical response:
1. Comment \`CLAIMED: addressing Codex review at ${expectedHead}\` on pull request #${pullRequestNumber}.
2. Evaluate every blocking finding independently. Do not accept a claim merely because Codex made it.
3. Before writing or pushing, re-read the live pull request head. If it is no longer ${expectedHead}, do not modify or push the stale checkout; stop so the newer head can proceed through review.
4. For valid findings on the unchanged head, implement the complete fix on branch \`${branch}\`, update required tests and documentation, run the checks appropriate to the new diff, commit, and push. The push must advance the pull request head and will trigger a fresh Codex review.
5. If every blocking finding is technically invalid, post one concrete English rebuttal on the pull request and add the exact label \`automation/review-ready\` without changing the branch. That label requests one same-head rereview.
6. If you cannot complete either path, post one English \`BLOCKED:\` comment with evidence and do not claim success.

Do not delegate implementation to Codex or wait for another local process. Finish only after pushing a new head, requesting the one same-head rereview, or posting the BLOCKED handoff.`

  await run(config.dshNode, [config.dshScript, '--profile', 'headless', prompt], {
    cwd: checkoutPath,
    env: hostCredentialEnvironment({
      DSH_HOME: config.dshHome,
      DSH_PERMISSION_MODE: 'danger-full-access',
      DSH_TELEMETRY_DISABLED: '1',
      NO_COLOR: '1',
    }),
    tee: true,
    timeoutMs: 3 * 60 * 60 * 1000,
  })

  const current = await ghJson(['api', `repos/${repository}/pulls/${pullRequestNumber}`], 'pull request after DSH repair')
  if (current.head.sha !== expectedHead) {
    await upsertStatus('complete', branch, `The pull request advanced to ${current.head.sha} while this session was active; GitHub will review the newer head.`)
    process.stdout.write(`Pull request #${pullRequestNumber} advanced to ${current.head.sha}; the stale repair is complete.\n`)
  } else if (current.labels.some(label => label.name === 'automation/review-ready')) {
    await upsertStatus('complete', branch, 'DSH posted a technical rebuttal and requested one same-head Codex rereview.')
    process.stdout.write(`DSH requested a same-head rereview for pull request #${pullRequestNumber}.\n`)
  } else {
    throw new Error('DSH exited successfully without advancing the head or requesting the documented same-head rereview')
  }
} catch (error) {
  await upsertStatus('failed', branch, `The repair run failed: ${String(error.message).slice(0, 1000)}`)
    .catch(() => undefined)
  await run(config.ghExecutable, [
    'pr', 'edit', String(pullRequestNumber), '--repo', repository, '--add-label', 'agent/dsh-failed',
  ], { env: hostCredentialEnvironment() }).catch(() => undefined)
  throw error
} finally {
  await removeJobDirectory(runnerTemp, jobPath)
}
