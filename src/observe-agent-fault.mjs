import { actionsCredentialEnvironment, parseJson, requiredEnv, run } from './common.mjs'
import { observeReviewInfrastructureFault, recordedReviewFailure } from './fault-observation.mjs'
import { classifyControllerFailure, verifyAgentFailureRole, workflowFailureSignature } from './failure-classification.mjs'
import { faultIdentity } from './fault-record.mjs'
import { faultProjectionBody, faultProjectionMarker, parseFaultProjection } from './fault-projection.mjs'

const repository = requiredEnv('TARGET_REPOSITORY')
const sourceRunId = requiredEnv('FAULT_SOURCE_RUN_ID')
const sourceRunNumber = Number.parseInt(sourceRunId, 10)
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
  || String(sourceRunNumber) !== sourceRunId) throw new Error('Fault observer run identity is invalid')
const sourceRun = await ghJson(['api', `repos/${repository}/actions/runs/${sourceRunId}`], 'fault source workflow run')
const sourceJobs = await pages(`repos/${repository}/actions/runs/${sourceRunId}/jobs`, 'fault source workflow jobs', 'jobs')
const verifiedRole = verifyAgentFailureRole({
  run: sourceRun,
  repository,
  trust: { controllerRepository, controllerSha },
})
const preliminaryClassification = classifyControllerFailure({
  run: sourceRun,
  jobs: sourceJobs,
  provenance: verifiedRole,
})
const observed = observeReviewInfrastructureFault({
  run: sourceRun,
  jobs: sourceJobs,
  repository,
  trust: { controllerRepository, controllerSha },
})
if (!observed) {
  process.stdout.write(`Failure classification: ${JSON.stringify(preliminaryClassification)}\n`)
  process.stdout.write(`Fault observer ignored source workflow run ${sourceRunId}.\n`)
  process.exit(0)
}
const current = await ghJson(['api', `repos/${repository}/pulls/${observed.subject.number}`], `pull request #${observed.subject.number}`)
if (current.state !== 'open'
  || current.base?.sha !== observed.subject.base
  || current.head?.sha !== observed.subject.head
  || current.head?.repo?.full_name !== repository) {
  process.stdout.write(`Fault observer ignored stale review pair #${observed.subject.number}.\n`)
  process.exit(0)
}
const checkRuns = await pages(`repos/${repository}/commits/${observed.subject.head}/check-runs`, 'exact-head review checks', 'check_runs')
const recordedFailure = recordedReviewFailure(checkRuns, sourceRunNumber, repository)
const observation = {
  ...observed,
  ...(recordedFailure || {}),
  failureSignature: workflowFailureSignature(sourceRun, sourceJobs),
  projectionRunId,
  controllerRepository,
  controllerSha,
}
delete observation.subject
const classification = classifyControllerFailure({
  run: sourceRun,
  jobs: sourceJobs,
  provenance: verifiedRole,
  failureClass: observation.failureClass,
})
const issueNumber = await upsertFault(observation)
process.stdout.write(`Failure classification: ${JSON.stringify(classification)}\n`)
process.stdout.write(`Fault observer projected review infrastructure fault as Issue #${issueNumber}.\n`)
