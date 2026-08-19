import { actionsCredentialEnvironment, authenticatedMarker, parseJson, requiredEnv, run, trustedAssociation } from './common.mjs'
import { recordedCiWorkflow, recoveryDecision, recoveryMarkerBody, trustedFailedAgentRun } from './recovery-policy.mjs'
import { reviewRunIdFromCheckRun } from './landing-policy.mjs'
import { recordedFailureClass, workflowFailureSignature } from './failure-classification.mjs'
import { REVIEW_CHECK_NAME, REVIEW_DISPATCH_TYPE } from './review-authority.mjs'
import { faultIdentity } from './fault-record.mjs'
import { faultProjectionBody, faultProjectionMarker } from './fault-projection.mjs'
import { governorBudgetDecision, governorDecision, subjectStateVersion } from './governor-policy.mjs'
import {
  attestedGovernorRecordBody,
  GOVERNOR_WORKFLOW_PATHS,
  issueGovernorSubject,
  pullRequestGovernorSubject,
  trustedGovernorRecords,
} from './governor-state.mjs'

const repository = requiredEnv('TARGET_REPOSITORY')
const sourceRunId = requiredEnv('RECOVERY_SOURCE_RUN_ID')
const controllerRepository = requiredEnv('TRUSTED_CONTROLLER_REPOSITORY')
const controllerSha = requiredEnv('TRUSTED_CONTROLLER_SHA')
const githubExecutable = process.env.GH_EXECUTABLE?.trim() || 'gh'
const environment = actionsCredentialEnvironment()
const governorRunId = Number.parseInt(requiredEnv('GITHUB_RUN_ID'), 10)
const governorTrust = {
  repository,
  controllerRepository,
  workflowPaths: GOVERNOR_WORKFLOW_PATHS,
}
const governorWriterTrust = {
  repository,
  controllerRepository,
  controllerSha,
  workflowPath: '.github/workflows/recover-backlog.yml',
}

async function ghJson(args, description) {
  const result = await run(githubExecutable, args, { env: environment })
  return parseJson(result.stdout, description)
}

function paginatedPath(path, page) {
  const endpoint = new URL(path, 'https://api.github.invalid/')
  endpoint.searchParams.set('per_page', '100')
  endpoint.searchParams.set('page', String(page))
  return `${endpoint.pathname.replace(/^\//, '')}?${endpoint.searchParams}`
}

async function pages(path, description, field) {
  const values = []
  for (let page = 1; page <= 3; page += 1) {
    const payload = await ghJson(['api', paginatedPath(path, page)], description)
    const pageValues = field === undefined ? payload : payload?.[field]
    if (!Array.isArray(pageValues)) throw new Error(`${description} did not return a page array`)
    values.push(...pageValues)
    if (pageValues.length < 100 || (field && Number.isSafeInteger(payload.total_count) && values.length >= payload.total_count)) return values
  }
  throw new Error(`${description} exceeded the bounded three-page snapshot`)
}

async function upsertInfrastructureFault({ role, subject, failureClass, errorCode, failureSignature }) {
  if (!['transport', 'auth-quota', 'protocol', 'host', 'permissions'].includes(failureClass)) return
  const observation = {
    repository,
    component: role === 'review' ? 'review-worker' : 'change-worker',
    operation: `recover-${role}`,
    failureClass,
    errorCode,
    failureSignature,
    rootRequestIds: [`${subject.type}-${subject.number}`],
    sourceRunId: Number.parseInt(sourceRunId, 10),
    projectionRunId: governorRunId,
    controllerRepository,
    controllerSha,
  }
  const faultId = faultIdentity(observation)
  const issues = (await pages(`repos/${repository}/issues?state=all&labels=automation%2Ffault&per_page=100`, 'infrastructure faults'))
    .filter(issue => !issue.pull_request)
  const existing = issues.find(issue => String(issue.body || '').includes(faultProjectionMarker(faultId)))
  if (existing) {
    await run(githubExecutable, ['api', '--method', 'PATCH', `repos/${repository}/issues/${existing.number}`, '--input', '-'], {
      env: environment,
      input: JSON.stringify({ body: faultProjectionBody(observation), state: 'open' }),
    })
    return
  }
  await run(githubExecutable, ['label', 'create', 'automation/fault', '--repo', repository,
    '--description', 'Controller-owned infrastructure fault projection', '--color', 'B60205'], { env: environment }).catch(() => undefined)
  await run(githubExecutable, ['api', '--method', 'POST', `repos/${repository}/issues`, '--input', '-'], {
    env: environment,
    input: JSON.stringify({
      title: `[Infrastructure] ${observation.component} ${observation.operation} failed`,
      body: faultProjectionBody(observation),
      labels: ['automation/fault'],
    }),
  })
}

async function writeGovernorRecord(number, record) {
  await run(githubExecutable, [
    'api', '--method', 'POST', `repos/${repository}/issues/${number}/comments`, '--input', '-',
  ], {
    env: environment,
    input: JSON.stringify({ body: attestedGovernorRecordBody(record, { ...governorWriterTrust, runId: governorRunId }) }),
  })
}

async function governRecovery(current, comments) {
  if (current.labels?.some(label => (typeof label === 'string' ? label : label?.name) === 'automation/paused')) {
    return { execute: false, action: 'paused' }
  }
  const subject = current.pull_request || current.head
    ? pullRequestGovernorSubject(current)
    : issueGovernorSubject(current)
  const stateVersion = subjectStateVersion(subject)
  const records = await trustedGovernorRecords({
    comments,
    trust: governorTrust,
    loadRun: runId => ghJson(['api', `repos/${repository}/actions/runs/${runId}`], `governor workflow run ${runId}`),
  })
  let workingRecords = records
  if (!records.some(record => record.status === 'candidate'
    && record.transition === 'workflow-recovery'
    && record.subject.type === subject.type
    && record.subject.number === subject.number
    && record.stateVersion === stateVersion)) {
    const candidate = governorDecision({
      transition: 'workflow-recovery', subject, stateVersion,
      observationId: `source-run-${sourceRunId}`, records,
    })
    if (candidate.record) {
      await writeGovernorRecord(subject.number, candidate.record)
      workingRecords = [...records, candidate.record]
    }
  }
  const decision = governorDecision({
    transition: 'workflow-recovery', subject, stateVersion,
    observationId: `recovery-run-${governorRunId}`, records: workingRecords,
  })
  if (decision.record) await writeGovernorRecord(subject.number, decision.record)
  if (!decision.execute) return { execute: false, action: decision.action }
  const budget = governorBudgetDecision({
    transition: 'workflow-recovery',
    subject: { type: subject.type, number: subject.number },
    workIdentity: subject.type === 'issue' ? `issue:${subject.number}` : `branch:${current.head.ref}`,
    observationId: `recovery-run-${governorRunId}`,
    limit: 3,
    records: workingRecords,
  })
  if (budget.record) await writeGovernorRecord(subject.number, budget.record)
  if (!budget.execute) {
    if (budget.action !== 'pause') return { execute: false, action: budget.action }
    await run(githubExecutable, [
      'label', 'create', 'automation/paused', '--repo', repository,
      '--description', 'Automatic governor budget exhausted', '--color', 'D93F0B',
    ], { env: environment }).catch(() => undefined)
    await run(githubExecutable, [subject.type === 'issue' ? 'issue' : 'pr', 'edit', String(subject.number), '--repo', repository,
      '--add-label', 'automation/paused'], { env: environment })
    return { execute: false, action: 'pause' }
  }
  return { execute: true, subject, stateVersion }
}

async function markRecoveryApplied(governed) {
  await writeGovernorRecord(governed.subject.number, {
    version: 1,
    status: 'applied',
    transition: 'workflow-recovery',
    subject: { type: governed.subject.type, number: governed.subject.number },
    stateVersion: governed.stateVersion,
    observationId: `recovery-run-${governorRunId}`,
  })
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

function workflowFailureClass(run, sourceComment) {
  return recordedFailureClass(sourceComment?.body)
    || (['cancelled', 'timed_out', 'startup_failure', 'stale'].includes(run.conclusion) ? 'transport' : 'task')
}

async function waitForRetry(decision) {
  if (decision.action !== 'retry' || !decision.delaySeconds) return
  await new Promise(resolvePromise => setTimeout(resolvePromise, decision.delaySeconds * 1000))
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
  return pages(`repos/${repository}/actions/runs/${sourceRunId}/jobs`, 'review workflow jobs', 'jobs')
}

function reviewProfileId(run) {
  const match = /^Agent PR Review #\d+ [0-9a-f]{40}\.\.[0-9a-f]{40} profile:([A-Za-z0-9][A-Za-z0-9._-]{0,63})$/.exec(String(run.display_title || ''))
  return match?.[1] || 'github-pr-cycle'
}

async function reviewSubject(run) {
  const profileId = reviewProfileId(run)
  const candidates = (run.pull_requests || []).filter(pullRequest => Number.isSafeInteger(pullRequest.number)
    && /^[0-9a-f]{40}$/.test(pullRequest.base?.sha || '')
    && /^[0-9a-f]{40}$/.test(pullRequest.head?.sha || '')
    && pullRequest.head.sha === run.head_sha)
  if (candidates.length === 1) {
    return {
      type: 'pull-request',
      number: candidates[0].number,
      base: candidates[0].base.sha,
      head: candidates[0].head.sha,
      profileId,
    }
  }
  const title = /^Agent PR Review #(\d+) ([0-9a-f]{40})\.\.([0-9a-f]{40})(?: profile:[A-Za-z0-9][A-Za-z0-9._-]{0,63})?$/.exec(String(run.display_title || ''))
  if (title && ((run.event === 'pull_request_target' && title[3] === run.head_sha)
    || (run.event === 'repository_dispatch' && title[2] === run.head_sha))) {
    return { type: 'pull-request', number: Number.parseInt(title[1], 10), base: title[2], head: title[3], profileId }
  }
  const pullRequests = await pages(`repos/${repository}/pulls?state=open&per_page=100`, 'open pull requests for review recovery')
  const matches = []
  for (const pullRequest of pullRequests) {
    const sourceRefMatches = run.event === 'pull_request_target'
      ? pullRequest.head?.sha === run.head_sha
      : pullRequest.base?.sha === run.head_sha
    if (!sourceRefMatches || pullRequest.head?.repo?.full_name !== repository) continue
    const checkRuns = await pages(
      `repos/${repository}/commits/${pullRequest.head.sha}/check-runs`,
      `review checks for pull request #${pullRequest.number}`,
      'check_runs',
    )
    if (checkRuns.some(checkRun => checkRun.name === REVIEW_CHECK_NAME
      && checkRun.app?.id === 15368
      && reviewRunIdFromCheckRun(checkRun, repository) === Number.parseInt(sourceRunId, 10))) {
      matches.push({ type: 'pull-request', number: pullRequest.number, base: pullRequest.base.sha, head: pullRequest.head.sha })
    }
  }
  return matches.length === 1 ? matches[0] : null
}

async function markReviewDeadLetter(number) {
  await run(githubExecutable, [
    'label', 'create', 'automation/review-failed', '--repo', repository,
    '--description', 'Agent review automation exhausted bounded recovery', '--color', 'D93F0B',
  ], { env: environment }).catch(() => undefined)
  await run(githubExecutable, ['pr', 'edit', String(number), '--repo', repository,
    '--add-label', 'automation/review-failed'], { env: environment })
}

async function wakeExactReview(subject) {
  await run(githubExecutable, [
    'label', 'create', 'automation/review-ready', '--repo', repository,
    '--description', 'A current pull request needs an Agent review', '--color', '1D76DB',
  ], { env: environment }).catch(() => undefined)
  await run(githubExecutable, ['pr', 'edit', String(subject.number), '--repo', repository,
    '--add-label', 'automation/review-ready'], { env: environment })
  await run(githubExecutable, ['api', '--method', 'POST', `repos/${repository}/dispatches`,
    '-f', `event_type=${REVIEW_DISPATCH_TYPE}`,
    '-F', `client_payload[pull_request_number]=${subject.number}`,
    '-f', `client_payload[base_sha]=${subject.base}`,
    '-f', `client_payload[head_sha]=${subject.head}`,
    '-f', `client_payload[profile_id]=${subject.profileId || 'github-pr-cycle'}`,
    '-f', `client_payload[request_id]=recovery-${sourceRunId}`], { env: environment })
}

const workflowRun = await ghJson(['api', `repos/${repository}/actions/runs/${sourceRunId}`], 'recovery source workflow run')
const trust = { controllerRepository, controllerSha }
const role = trustedFailedAgentRun({ run: workflowRun, repository, trust })
if (!role) {
  process.stdout.write(`Recovery ignored untrusted source workflow run ${sourceRunId}.\n`)
  process.exit(0)
}
const sourceJobs = await reviewJobs()
const failureSignature = workflowFailureSignature(workflowRun, sourceJobs)

if (role === 'review') {
  const subject = await reviewSubject(workflowRun)
  if (!subject) {
    process.stdout.write(`Recovery ignored review run ${sourceRunId} without one exact pull request pair.\n`)
    process.exit(0)
  }
  const current = await ghJson(['api', `repos/${repository}/pulls/${subject.number}`], `pull request #${subject.number}`)
  const comments = await pages(`repos/${repository}/issues/${subject.number}/comments?per_page=100`, `comments for #${subject.number}`)
  const failureClass = workflowFailureClass(workflowRun)
  const decision = recoveryDecision({
    run: workflowRun,
    jobs: sourceJobs,
    repository,
    trust,
    subject,
    current,
    attempts: attemptRecords(comments, subject),
    failureClass,
  })
  if (decision.action === 'ignore') {
    process.stdout.write(`Recovery left review run ${sourceRunId} without another model review.\n`)
    process.exit(0)
  }
  const governed = await governRecovery(current, comments)
  if (!governed.execute) {
    if (governed.action === 'pause') await upsertInfrastructureFault({
      role, subject, failureClass, errorCode: workflowRun.conclusion, failureSignature,
    })
    process.stdout.write(`Governor ${governed.action}; review recovery did not wake work.\n`)
    process.exit(0)
  }
  await markRecoveryApplied(governed)
  await upsertRecovery(subject, comments, decision.attempt, decision.action === 'retry' ? 'retrying' : 'dead-letter')
  if (decision.action === 'dead-letter') {
    await upsertInfrastructureFault({ role, subject, failureClass, errorCode: workflowRun.conclusion, failureSignature })
    await markReviewDeadLetter(subject.number)
  } else {
    await waitForRetry(decision)
    await wakeExactReview(subject)
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
  const failureClass = workflowFailureClass(workflowRun, sourceComment || sourceComments[0])
  const decision = recoveryDecision({
    run: workflowRun, repository, trust, subject, current,
    attempts: attemptRecords(comments, subject),
    failureClass,
  })
  if (decision.action === 'ignore') continue
  const governed = await governRecovery(current, comments)
  if (!governed.execute) {
    if (governed.action === 'pause') await upsertInfrastructureFault({
      role, subject, failureClass, errorCode: workflowRun.conclusion, failureSignature,
    })
    continue
  }
  await markRecoveryApplied(governed)
  await upsertRecovery(subject, comments, decision.attempt, decision.action === 'retry' ? 'retrying' : 'dead-letter')
  if (decision.action === 'dead-letter') {
    await upsertInfrastructureFault({ role, subject, failureClass, errorCode: workflowRun.conclusion, failureSignature })
    await run(githubExecutable, [subject.type === 'issue' ? 'issue' : 'pr', 'edit', String(subject.number), '--repo', repository,
      '--add-label', 'agent/dsh-failed'], { env: environment }).catch(() => undefined)
    recovered += 1
    continue
  }
  if (subject.type === 'issue') {
    await waitForRetry(decision)
    for (const label of ['agent/dsh', 'agent/dsh-failed']) {
      await run(githubExecutable, ['issue', 'edit', String(subject.number), '--repo', repository,
        '--remove-label', label], { env: environment }).catch(() => undefined)
    }
    await run(githubExecutable, ['issue', 'edit', String(subject.number), '--repo', repository,
      '--add-label', 'agent/dsh'], { env: environment })
    await run(githubExecutable, ['api', '--method', 'POST', `repos/${repository}/dispatches`,
      '-f', 'event_type=dsh-issue',
      '-F', `client_payload[issue_number]=${subject.number}`,
      '-f', `client_payload[request_id]=recovery-${sourceRunId}-${decision.attempt}`], { env: environment })
  } else {
    await waitForRetry(decision)
    const originalRequestId = repairRequestId(sourceComment.body, subject.head)
    const recoveryRequestId = originalRequestId.startsWith('ci-run-')
      ? `${originalRequestId}.recovery-${decision.attempt}`
      : decision.requestId
    const ciWorkflow = originalRequestId.startsWith('ci-run-') ? recordedCiWorkflow(sourceComment.body) : ''
    if (originalRequestId.startsWith('ci-run-') && !ciWorkflow) {
      throw new Error(`CI recovery for pull request #${subject.number} has no recorded workflow name`)
    }
    await run(githubExecutable, ['api', '--method', 'POST', `repos/${repository}/dispatches`,
      '-f', 'event_type=dsh-repair', '-F', `client_payload[pr_number]=${subject.number}`,
      '-F', `client_payload[head_sha]=${subject.head}`, '-F', `client_payload[request_id]=${recoveryRequestId}`,
      ...(ciWorkflow ? ['-f', `client_payload[ci_workflow_name]=${ciWorkflow}`] : [])], { env: environment })
  }
  recovered += 1
}
process.stdout.write(`Recovery processed ${recovered} exact subject(s) from workflow run ${sourceRunId}.\n`)
