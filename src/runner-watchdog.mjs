import { actionsCredentialEnvironment, parseJson, requiredEnv, run } from './common.mjs'

const repository = requiredEnv('TARGET_REPOSITORY')
const controllerRepository = requiredEnv('CONTROLLER_REPOSITORY')
const githubExecutable = process.env.GH_EXECUTABLE?.trim() || 'gh'
const environment = actionsCredentialEnvironment()
const now = Date.now()
const maximumQueueAgeMs = 20 * 60 * 1000
const maximumMaintenanceAgeMs = 40 * 60 * 1000

async function boundedPages(path, field, description) {
  const values = []
  for (let page = 1; page <= 4; page += 1) {
    const result = await run(githubExecutable, ['api', `${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`], {
      env: environment,
    })
    const payload = parseJson(result.stdout, description)
    const pageValues = field === undefined ? payload : payload?.[field]
    if (!Array.isArray(pageValues)) throw new Error(`${description} did not contain ${field}`)
    if (page === 4 && pageValues.length > 0) {
      throw new Error(`${description} exceeded the bounded three-page snapshot`)
    }
    values.push(...pageValues)
    if (pageValues.length < 100) break
  }
  return values
}

async function queuedRuns(targetRepository) {
  return boundedPages(`repos/${targetRepository}/actions/runs?status=queued`, 'workflow_runs', 'queued Agent workflow runs')
}

const stale = [
  ...(await queuedRuns(repository)).filter(workflowRun => /^Agent\b/.test(workflowRun.name || '')),
  ...(await queuedRuns(controllerRepository)).filter(workflowRun => ['Controller Maintenance', 'Controller Maintenance Readiness'].includes(workflowRun.name)),
].filter(workflowRun =>
  workflowRun.repository?.full_name === undefined || [repository, controllerRepository].includes(workflowRun.repository.full_name))
  .filter(workflowRun => now - Date.parse(workflowRun.created_at) > maximumQueueAgeMs)
if (stale.length > 0) {
  throw new Error(`Agent workflows queued over 20 minutes: ${stale.map(runValue => `${runValue.name}#${runValue.id}`).join(', ')}`)
}

const maintenanceRuns = await boundedPages(
  `repos/${controllerRepository}/actions/workflows/controller-maintenance.yml/runs?status=completed`,
  'workflow_runs',
  'Controller Maintenance workflow runs',
)
const latestSuccessfulMaintenance = maintenanceRuns
  .filter(workflowRun => workflowRun.conclusion === 'success')
  .sort((left, right) => Date.parse(right.updated_at) - Date.parse(left.updated_at))[0]
if (!latestSuccessfulMaintenance
  || now - Date.parse(latestSuccessfulMaintenance.updated_at) > maximumMaintenanceAgeMs) {
  throw new Error('Controller Maintenance has no successful run in the last 40 minutes')
}

const readinessRuns = await boundedPages(
  `repos/${controllerRepository}/actions/workflows/controller-maintenance-readiness.yml/runs?status=completed`,
  'workflow_runs',
  'Controller Maintenance Readiness workflow runs',
)
const latestSuccessfulReadiness = readinessRuns
  .filter(workflowRun => workflowRun.conclusion === 'success')
  .sort((left, right) => Date.parse(right.updated_at) - Date.parse(left.updated_at))[0]
if (!latestSuccessfulReadiness || now - Date.parse(latestSuccessfulReadiness.updated_at) > maximumMaintenanceAgeMs) {
  throw new Error('Controller Maintenance Readiness has no successful run in the last 40 minutes')
}

const openFaults = await boundedPages(
  `repos/${repository}/issues?state=open&labels=automation%2Ffault`,
  undefined,
  'open automation faults',
)
const faultIssues = openFaults.filter(issue => !issue.pull_request)
if (faultIssues.length > 0) {
  throw new Error(`Unresolved automation faults: ${faultIssues.map(issue => `#${issue.number}`).join(', ')}`)
}

process.stdout.write('Agent queues, Controller Maintenance, and automation faults are healthy.\n')
