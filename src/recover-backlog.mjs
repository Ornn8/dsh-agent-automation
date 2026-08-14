import { actionsCredentialEnvironment, authenticatedMarker, parseJson, requiredEnv, run, trustedAssociation } from './common.mjs'
import { recoveryDecision, recoveryMarkerBody, trustedFailedAgentRun } from './recovery-policy.mjs'

const repository = requiredEnv('TARGET_REPOSITORY')
const sourceRunId = requiredEnv('RECOVERY_SOURCE_RUN_ID')
const controllerRepository = requiredEnv('TRUSTED_CONTROLLER_REPOSITORY')
const controllerSha = requiredEnv('TRUSTED_CONTROLLER_SHA')
const githubExecutable = process.env.GH_EXECUTABLE?.trim() || 'gh'
const environment = actionsCredentialEnvironment()

async function ghJson(args, description) {
  const result = await run(githubExecutable, args, { env: environment })
  return parseJson(result.stdout, description)
}

async function pages(path, description) {
  return (await ghJson(['api', path, '--paginate', '--slurp'], description)).flat()
}

function sourceMarker(body) {
  return new RegExp(`- Run: https://github\\.com/${repository.replace('/', '\\/')}\\/actions\\/runs/${sourceRunId}\\s*$`, 'm').test(String(body || ''))
}

function reviewedHead(body) {
  return /^- Reviewed head: `([0-9a-f]{40})`$/m.exec(String(body || ''))?.[1] || null
}

function repairRequestId(body, head) {
  const escapedHead = head.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const escapedController = controllerSha.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const text = String(body || '')
  return new RegExp(`<!-- dsh-review-repair:${escapedController}:${escapedHead}:([^ >]{1,100}) -->`).exec(text)?.[1]
    || new RegExp(`<!-- dsh-review-repair:${escapedHead}:([^ >]{1,100}) -->`).exec(text)?.[1]
    || ''
}

function attemptRecords(comments, subject) {
  const head = subject.type === 'pull-request'
    ? `:${subject.base ? `${subject.base}:` : ''}${subject.head}` : ''
  const marker = `<!-- dsh-recovery:${subject.type}:${subject.number}${head} -->`
  return comments.flatMap(comment => {
    if (!authenticatedMarker(comment, marker, 'github-actions[bot]')) return []
    const attempt = Number.parseInt(/^- Attempt: (\d+)$/m.exec(comment.body)?.[1] || '', 10)
    return Number.isSafeInteger(attempt) ? [{ attempt }] : []
  })
}

async function upsertRecovery(subject, comments, attempt, status) {
  const head = subject.type === 'pull-request'
    ? `:${subject.base ? `${subject.base}:` : ''}${subject.head}` : ''
  const marker = `<!-- dsh-recovery:${subject.type}:${subject.number}${head} -->`
  const body = recoveryMarkerBody(subject, attempt, sourceRunId, status, repository)
  const existing = comments.find(comment => authenticatedMarker(comment, marker, 'github-actions[bot]'))
  const path = subject.type === 'issue'
    ? `repos/${repository}/issues/${subject.number}/comments`
    : `repos/${repository}/issues/${subject.number}/comments`
  if (existing) {
    await run(githubExecutable, ['api', '--method', 'PATCH', `repos/${repository}/issues/comments/${existing.id}`, '-f', `body=${body}`], { env: environment })
  } else {
    await run(githubExecutable, ['api', '--method', 'POST', path, '-f', `body=${body}`], { env: environment })
  }
}

async function reviewJobs() {
  const result = await ghJson([
    'api', `repos/${repository}/actions/runs/${sourceRunId}/jobs?per_page=100`, '--paginate', '--slurp',
  ], 'review workflow jobs')
  return result.flatMap(page => page.jobs || [])
}

function reviewSubject(run) {
  const candidates = (run.pull_requests || []).filter(pullRequest => Number.isSafeInteger(pullRequest.number)
    && /^[0-9a-f]{40}$/.test(pullRequest.base?.sha || '')
    && /^[0-9a-f]{40}$/.test(pullRequest.head?.sha || '')
    && pullRequest.base.sha === run.head_sha)
  if (candidates.length !== 1) return null
  return {
    type: 'pull-request',
    number: candidates[0].number,
    base: candidates[0].base.sha,
    head: candidates[0].head.sha,
  }
}

async function markReviewDeadLetter(number) {
  await run(githubExecutable, [
    'label', 'create', 'automation/review-failed', '--repo', repository,
    '--description', 'Codex review automation exhausted bounded recovery', '--color', 'D93F0B',
  ], { env: environment }).catch(() => undefined)
  await run(githubExecutable, ['pr', 'edit', String(number), '--repo', repository,
    '--add-label', 'automation/review-failed'], { env: environment })
}

async function wakeExactReview(number) {
  await run(githubExecutable, [
    'label', 'create', 'automation/review-ready', '--repo', repository,
    '--description', 'A current pull request needs a Codex review', '--color', '1D76DB',
  ], { env: environment }).catch(() => undefined)
  await run(githubExecutable, ['pr', 'edit', String(number), '--repo', repository,
    '--remove-label', 'automation/review-ready'], { env: environment }).catch(() => undefined)
  await run(githubExecutable, ['pr', 'edit', String(number), '--repo', repository,
    '--add-label', 'automation/review-ready'], { env: environment })
}

const workflowRun = await ghJson(['api', `repos/${repository}/actions/runs/${sourceRunId}`], 'recovery source workflow run')
const trust = { controllerRepository, controllerSha }
const role = trustedFailedAgentRun({ run: workflowRun, repository, trust })
if (!role) {
  process.stdout.write(`Recovery ignored untrusted source workflow run ${sourceRunId}.\n`)
  process.exit(0)
}

if (role === 'review') {
  const subject = reviewSubject(workflowRun)
  if (!subject) {
    process.stdout.write(`Recovery ignored review run ${sourceRunId} without one exact pull request pair.\n`)
    process.exit(0)
  }
  const current = await ghJson(['api', `repos/${repository}/pulls/${subject.number}`], `pull request #${subject.number}`)
  const comments = await pages(`repos/${repository}/issues/${subject.number}/comments?per_page=100`, `comments for #${subject.number}`)
  const decision = recoveryDecision({
    run: workflowRun,
    jobs: await reviewJobs(),
    repository,
    trust,
    subject,
    current,
    attempts: attemptRecords(comments, subject),
  })
  if (decision.action === 'ignore') {
    process.stdout.write(`Recovery left review run ${sourceRunId} without another model review.\n`)
    process.exit(0)
  }
  await upsertRecovery(subject, comments, decision.attempt, decision.action === 'retry' ? 'retrying' : 'dead-letter')
  if (decision.action === 'dead-letter') {
    await markReviewDeadLetter(subject.number)
  } else {
    await wakeExactReview(subject.number)
  }
  process.stdout.write(`Recovery processed review pair #${subject.number} at ${subject.base}..${subject.head}.\n`)
  process.exit(0)
}

const subjects = role === 'issue'
  ? (await pages(`repos/${repository}/issues?state=open&per_page=100`, 'open issues')).filter(issue => !issue.pull_request)
  : await pages(`repos/${repository}/pulls?state=open&per_page=100`, 'open pull requests')
let recovered = 0
for (const current of subjects) {
  const comments = await pages(`repos/${repository}/issues/${current.number}/comments?per_page=100`, `comments for #${current.number}`)
  const sourceComments = comments.filter(comment => trustedAssociation(comment.author_association) && sourceMarker(comment.body))
  if (sourceComments.length === 0) continue
  const sourceComment = role === 'pull-request'
    ? sourceComments.find(comment => reviewedHead(comment.body))
    : null
  const sourceHead = sourceComment ? reviewedHead(sourceComment.body) : null
  if (role === 'pull-request' && !sourceHead) continue
  const subject = role === 'issue'
    ? { type: 'issue', number: current.number }
    : { type: 'pull-request', number: current.number, head: sourceHead }
  const decision = recoveryDecision({
    run: workflowRun, repository, trust, subject, current,
    attempts: attemptRecords(comments, subject),
  })
  if (decision.action === 'ignore') continue
  await upsertRecovery(subject, comments, decision.attempt, decision.action === 'retry' ? 'retrying' : 'dead-letter')
  if (decision.action === 'dead-letter') {
    await run(githubExecutable, [subject.type === 'issue' ? 'issue' : 'pr', 'edit', String(subject.number), '--repo', repository,
      '--add-label', 'agent/dsh-failed'], { env: environment }).catch(() => undefined)
    recovered += 1
    continue
  }
  if (subject.type === 'issue') {
    for (const label of ['agent/dsh', 'agent/dsh-failed']) {
      await run(githubExecutable, ['issue', 'edit', String(subject.number), '--repo', repository,
        '--remove-label', label], { env: environment }).catch(() => undefined)
    }
    await run(githubExecutable, ['issue', 'edit', String(subject.number), '--repo', repository,
      '--add-label', 'agent/dsh'], { env: environment })
  } else {
    const originalRequestId = repairRequestId(sourceComment.body, subject.head)
    const recoveryRequestId = originalRequestId.startsWith('ci-run-')
      ? `${originalRequestId}.recovery-${decision.attempt}`
      : decision.requestId
    await run(githubExecutable, ['api', '--method', 'POST', `repos/${repository}/dispatches`,
      '-f', 'event_type=dsh-repair', '-F', `client_payload[pr_number]=${subject.number}`,
      '-F', `client_payload[head_sha]=${subject.head}`, '-F', `client_payload[request_id]=${recoveryRequestId}`], { env: environment })
  }
  recovered += 1
}
process.stdout.write(`Recovery processed ${recovered} exact subject(s) from workflow run ${sourceRunId}.\n`)
