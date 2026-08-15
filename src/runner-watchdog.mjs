import { actionsCredentialEnvironment, parseJson, requiredEnv, run } from './common.mjs'

const repository = requiredEnv('TARGET_REPOSITORY')
const githubExecutable = process.env.GH_EXECUTABLE?.trim() || 'gh'
const environment = actionsCredentialEnvironment()
const now = Date.now()
const maximumQueueAgeMs = 20 * 60 * 1000

async function queuedRuns() {
  const result = await run(githubExecutable, [
    'api', `repos/${repository}/actions/runs?status=queued&per_page=100`, '--paginate', '--slurp',
  ], { env: environment })
  const pages = parseJson(result.stdout, 'queued Agent workflow runs')
  if (pages.length > 3) throw new Error('Runner watchdog exceeded its bounded three-page snapshot')
  return pages.flatMap(page => page.workflow_runs || [])
}

const stale = (await queuedRuns()).filter(workflowRun => /^Agent\b/.test(workflowRun.name || '')
  && now - Date.parse(workflowRun.created_at) > maximumQueueAgeMs)
if (stale.length > 0) {
  throw new Error(`Agent workflows queued over 20 minutes: ${stale.map(runValue => `${runValue.name}#${runValue.id}`).join(', ')}`)
}
process.stdout.write('No Agent workflow has remained queued beyond 20 minutes.\n')
