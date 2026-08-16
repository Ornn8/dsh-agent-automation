import {
  actionsCredentialEnvironment,
  loadConfig,
  parseJson,
  requiredEnv,
  run,
} from './common.mjs'
import { governorDecision, subjectStateVersion } from './governor-policy.mjs'
import {
  attestedGovernorRecordBody,
  GOVERNOR_WORKFLOW_PATHS,
  pullRequestGovernorSubject,
  trustedGovernorRecords,
} from './governor-state.mjs'

const repository = requiredEnv('TARGET_REPOSITORY')
const pullRequestNumber = Number.parseInt(requiredEnv('PR_NUMBER'), 10)
const expectedBase = requiredEnv('BASE_SHA')
const expectedHead = requiredEnv('HEAD_SHA')
const config = await loadConfig()
const environment = actionsCredentialEnvironment()
const reviewRoute = requiredEnv('REVIEW_ROUTE')
const controllerRepository = requiredEnv('CONTROLLER_REPOSITORY')
const controllerSha = requiredEnv('CONTROLLER_SHA').toLowerCase()
const workflowPath = requiredEnv('GOVERNOR_WORKFLOW_PATH')
const runId = Number.parseInt(requiredEnv('RUN_ID'), 10)

if (!config.repositories.includes(repository)) throw new Error(`${repository} is not in the runner allowlist`)
if (!Number.isSafeInteger(pullRequestNumber) || pullRequestNumber < 1) {
  throw new Error(`Invalid PR_NUMBER: ${process.env.PR_NUMBER}`)
}
if (!['repair', 'retry', 'baseline', 'infrastructure', 'pause'].includes(reviewRoute)) {
  throw new Error(`Unsupported REVIEW_ROUTE ${reviewRoute}`)
}

async function ghJson(args, description) {
  const result = await run(config.ghExecutable, args, { env: environment })
  return parseJson(result.stdout, description)
}

const pullRequest = await ghJson([
  'api', `repos/${repository}/pulls/${pullRequestNumber}`,
], 'pull request')
if (pullRequest.state !== 'open' || pullRequest.draft) throw new Error('Pull request is not an open ready pull request')
if (pullRequest.head?.repo?.full_name !== repository) throw new Error('Fork pull requests cannot request privileged work')
if (pullRequest.base?.sha !== expectedBase || pullRequest.head?.sha !== expectedHead) {
  throw new Error('Pull request changed before the work request was published')
}
const trust = { repository, controllerRepository, workflowPaths: GOVERNOR_WORKFLOW_PATHS }
const writerTrust = { repository, controllerRepository, controllerSha, workflowPath }
const comments = (await ghJson([
  'api', `repos/${repository}/issues/${pullRequestNumber}/comments?per_page=100`, '--paginate', '--slurp',
], 'pull request governor records')).flat()
const records = await trustedGovernorRecords({
  comments,
  trust,
  loadRun: candidateRunId => ghJson([
    'api', `repos/${repository}/actions/runs/${candidateRunId}`,
  ], `governor workflow run ${candidateRunId}`),
})
const subject = pullRequestGovernorSubject(pullRequest)
const stateVersion = subjectStateVersion(subject)
if (reviewRoute !== 'repair' && reviewRoute !== 'retry') {
  if (!records.some(record => record.status === 'paused'
    && record.subject.type === 'pull-request'
    && record.subject.number === pullRequestNumber
    && record.stateVersion === stateVersion)) {
    await run(config.ghExecutable, [
      'api', '--method', 'POST', `repos/${repository}/issues/${pullRequestNumber}/comments`, '--input', '-',
    ], {
      env: environment,
      input: JSON.stringify({
        body: attestedGovernorRecordBody({
          version: 1,
          status: 'paused',
          transition: 'review-repair',
          subject: { type: 'pull-request', number: pullRequestNumber },
          stateVersion,
          observationId: `run-${runId}`,
          reason: `review-${reviewRoute}`,
        }, { ...writerTrust, runId }),
      }),
    })
  }
  await run(config.ghExecutable, [
    'label', 'create', 'automation/paused', '--repo', repository,
    '--description', 'Automatic controller work is paused until an authorized resume', '--color', 'D93F0B',
  ], { env: environment }).catch(() => undefined)
  await run(config.ghExecutable, [
    'pr', 'edit', String(pullRequestNumber), '--repo', repository,
    '--add-label', 'automation/paused',
  ], { env: environment })
  process.stdout.write(`Review route ${reviewRoute} paused product change work.\n`)
  process.exit(0)
}
const transition = reviewRoute === 'repair' ? 'review-repair' : 'workflow-recovery'
const decision = governorDecision({
  transition,
  subject,
  stateVersion,
  observationId: `run-${runId}`,
  records,
})
if (!decision.record) {
  process.stdout.write(`Governor ${decision.action}; no review work request was published.\n`)
  process.exit(0)
}
await run(config.ghExecutable, [
  'api', '--method', 'POST', `repos/${repository}/issues/${pullRequestNumber}/comments`, '--input', '-',
], {
  env: environment,
  input: JSON.stringify({ body: attestedGovernorRecordBody(decision.record, { ...writerTrust, runId }) }),
})
process.stdout.write(`Recorded ${transition} candidate for an independent later observation.\n`)
