import { reviewRunIdFromDetailsUrl } from './landing-policy.mjs'

const FULL_SHA = /^[0-9a-f]{40}$/
const GITHUB_ACTIONS_APP_ID = 15368

/** The only workflow definition whose result can advance Controller maintenance. */
export const MAINTENANCE_CI_WORKFLOW_PATH = '.github/workflows/controller-ci.yml'

function failed(detail) {
  return { outcome: 'failed', detail }
}

function validPullRequest(pull, repository) {
  return pull?.state === 'open'
    && Number.isSafeInteger(pull?.number) && pull.number > 0
    && pull.base?.repo?.full_name === repository
    && pull.head?.repo?.full_name === repository
    && FULL_SHA.test(pull.base?.sha || '')
    && FULL_SHA.test(pull.head?.sha || '')
}

function isExactWorkflowRun(run, pull, repository, workflowName) {
  return run?.repository?.full_name === repository
    && run.name === workflowName
    && run.path === MAINTENANCE_CI_WORKFLOW_PATH
    && run.event === 'pull_request'
    && run.head_sha === pull.head.sha
    && Array.isArray(run.pull_requests)
    && run.pull_requests.length === 1
    && run.pull_requests[0]?.number === pull.number
    && run.pull_requests[0]?.base?.sha === pull.base.sha
    && run.pull_requests[0]?.head?.sha === pull.head.sha
}

function latestRun(runs, workflowName) {
  const candidates = runs.filter(run => run?.name === workflowName && run?.path === MAINTENANCE_CI_WORKFLOW_PATH)
  return candidates.length > 0
    ? [...candidates].sort((left, right) => (right?.id || 0) - (left?.id || 0))[0]
    : null
}

/**
 * Assess Controller CI as functional evidence for one exact maintenance PR.
 * The result is accepted only when the newest workflow run and its required
 * CheckRun identify the Controller, fixed workflow, pull_request event, exact
 * PR pair, and successful completed execution.
 * @param {{ pull: object, files: unknown[], workflowRuns: object[], checkRuns: object[], repository: string, workflowName: string, requiredCheckNames: string[] }} input
 * @returns {{ outcome: 'waiting' | 'succeeded' | 'failed', runId?: number, detail?: string }}
 */
export function assessMaintenanceCi({
  pull, files, workflowRuns, checkRuns, repository, workflowName, requiredCheckNames,
}) {
  if (!validPullRequest(pull, repository)
    || typeof workflowName !== 'string' || !workflowName
    || !Array.isArray(requiredCheckNames) || requiredCheckNames.length < 1
    || requiredCheckNames.some(name => typeof name !== 'string' || !name)
    || !Array.isArray(files)) return failed('maintenance CI evidence has an invalid pull request or configuration')
  if (files.some(file => file?.filename === MAINTENANCE_CI_WORKFLOW_PATH)) {
    return failed('maintenance CI workflow definition changed in the candidate pull request')
  }
  if (!Array.isArray(workflowRuns)) return failed('maintenance CI workflow-run evidence is invalid')
  if (workflowRuns.length === 0) return { outcome: 'waiting' }

  const run = latestRun(workflowRuns, workflowName)
  if (!Number.isSafeInteger(run?.id) || run.id < 1
    || !isExactWorkflowRun(run, pull, repository, workflowName)) {
    return failed('maintenance CI workflow run is not the fixed Controller exact-pair run')
  }
  if (run.status !== 'completed') return { outcome: 'waiting', runId: run.id }
  if (run.conclusion !== 'success') return failed('maintenance CI workflow run did not succeed')
  if (!Array.isArray(checkRuns)) return failed('maintenance CI CheckRun evidence is invalid')

  for (const requiredCheckName of requiredCheckNames) {
    const namedChecks = checkRuns.filter(check => check?.name === requiredCheckName)
    if (namedChecks.length === 0) return { outcome: 'waiting', runId: run.id }
    const checkIds = namedChecks.map(check => check?.id)
    if (checkIds.some(id => !Number.isSafeInteger(id) || id < 1) || new Set(checkIds).size !== checkIds.length) {
      return failed(`maintenance CI CheckRun ${requiredCheckName} has an ambiguous identity`)
    }
    const check = [...namedChecks].sort((left, right) => right.id - left.id)[0]
    if (check.head_sha !== pull.head.sha
      || check.app?.id !== GITHUB_ACTIONS_APP_ID
      || reviewRunIdFromDetailsUrl(check.details_url, repository) !== run.id) {
      return failed(`maintenance CI CheckRun ${requiredCheckName} is not bound to the fixed Controller workflow run`)
    }
    if (check.status !== 'completed') return { outcome: 'waiting', runId: run.id }
    if (check.conclusion !== 'success') return failed(`maintenance CI required CheckRun ${requiredCheckName} did not succeed`)
  }
  return { outcome: 'succeeded', runId: run.id }
}
