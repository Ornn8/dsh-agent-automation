import { actionsCredentialEnvironment, parseJson, requiredEnv, run } from './common.mjs'
import { faultIdentity } from './fault-record.mjs'
import { faultProjectionBody, faultProjectionMarker, parseFaultProjection } from './fault-projection.mjs'
import {
  applyReviewFaultDecision,
  loadReviewFaultAuditDecision,
  reviewFaultAttemptEndpoints,
  verifyReviewFaultAttempt,
} from './review-fault-audit.mjs'

const repository = requiredEnv('TARGET_REPOSITORY')
const sourceRunId = requiredEnv('FAULT_SOURCE_RUN_ID')
const sourceRunNumber = Number.parseInt(sourceRunId, 10)
const sourceRunAttemptText = requiredEnv('FAULT_SOURCE_RUN_ATTEMPT')
const sourceRunAttempt = Number.parseInt(sourceRunAttemptText, 10)
const controllerRepository = requiredEnv('TRUSTED_CONTROLLER_REPOSITORY')
const controllerSha = requiredEnv('TRUSTED_CONTROLLER_SHA')
const projectionRunId = Number.parseInt(requiredEnv('GITHUB_RUN_ID'), 10)
const githubExecutable = process.env.GH_EXECUTABLE?.trim() || 'gh'
const environment = actionsCredentialEnvironment()

async function ghJson(args, description, options = {}) {
  const result = await run(githubExecutable, args, { env: environment, ...options })
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

async function upsertFault(observation) {
  const faultId = faultIdentity(observation)
  const issues = (await pages(`repos/${repository}/issues?state=all&labels=automation%2Ffault`, 'infrastructure faults'))
    .filter(issue => !issue.pull_request)
  const existing = issues.find(issue => {
    if (issue.user?.login !== 'github-actions[bot]'
      || !String(issue.body || '').includes(faultProjectionMarker(faultId))) return false
    try { return parseFaultProjection(issue.body).faultId === faultId } catch { return false }
  })
  let projected = observation
  if (existing) {
    const prior = parseFaultProjection(existing.body)
    projected = { ...observation, rootRequestIds: [...prior.rootRequestIds, ...observation.rootRequestIds] }
    await run(githubExecutable, ['api', '--method', 'PATCH', `repos/${repository}/issues/${existing.number}`, '--input', '-'], {
      env: environment,
      input: JSON.stringify({ body: faultProjectionBody(projected), state: 'open' }),
    })
    return existing.number
  }
  await run(githubExecutable, ['label', 'create', 'automation/fault', '--repo', repository,
    '--description', 'Controller-owned infrastructure fault projection', '--color', 'B60205'], { env: environment }).catch(() => undefined)
  const created = await ghJson(['api', '--method', 'POST', `repos/${repository}/issues`, '--input', '-'], 'created infrastructure fault', {
    input: JSON.stringify({
      title: `[Infrastructure] ${observation.component} ${observation.operation} failed`,
      body: faultProjectionBody(projected),
      labels: ['automation/fault'],
    }),
  })
  return created.number
}

if (!Number.isSafeInteger(projectionRunId) || projectionRunId < 1
  || !Number.isSafeInteger(sourceRunNumber) || sourceRunNumber < 1
  || String(sourceRunNumber) !== sourceRunId
  || !Number.isSafeInteger(sourceRunAttempt) || sourceRunAttempt < 1
  || String(sourceRunAttempt) !== sourceRunAttemptText) throw new Error('Fault observer run identity is invalid')
const attemptEndpoints = reviewFaultAttemptEndpoints(repository, sourceRunNumber, sourceRunAttempt)
const sourceRun = await ghJson(['api', attemptEndpoints.run], 'fault source workflow run attempt')
verifyReviewFaultAttempt(sourceRun, sourceRunNumber, sourceRunAttempt)
const sourceJobs = await pages(attemptEndpoints.jobs, 'fault source workflow attempt jobs', 'jobs')
const audit = await loadReviewFaultAuditDecision({
  run: sourceRun,
  jobs: sourceJobs,
  repository,
  trust: { controllerRepository, controllerSha },
  readPullRequest(number) {
    return ghJson(['api', `repos/${repository}/pulls/${number}`], `pull request #${number}`)
  },
  readCheckRuns(head) {
    return pages(`repos/${repository}/commits/${head}/check-runs`, 'exact-head review checks', 'check_runs')
  },
})
if (audit.observation) {
  audit.observation = {
    ...audit.observation,
    failureSignature: audit.failureSignature,
    projectionRunId,
    controllerRepository,
    controllerSha,
  }
  delete audit.observation.subject
}
const issueNumber = await applyReviewFaultDecision(audit, {
  writeAudit(classification) {
    process.stdout.write(`Failure classification: ${JSON.stringify(classification)}\n`)
  },
  upsertFault,
})
if (issueNumber === null) {
  process.stdout.write(`Fault observer ignored source workflow run ${sourceRunId}: ${audit.reason}.\n`)
} else {
  process.stdout.write(`Fault observer projected review infrastructure fault as Issue #${issueNumber}.\n`)
}
