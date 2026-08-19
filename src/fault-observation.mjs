import { intentionalReviewBlock, trustedFailedAgentRun } from './recovery-policy.mjs'
import { reviewWorkflowFailureJobs } from './failure-classification.mjs'
import { reviewRunIdFromCheckRun } from './landing-policy.mjs'
import { REVIEW_CHECK_NAME } from './review-authority.mjs'

const FULL_SHA = /^[0-9a-f]{40}$/
const PROJECTION_WORKFLOW_PATHS = [
  '.github/workflows/observe-agent-fault.yml',
  '.github/workflows/recover-backlog.yml',
]

/** Read a sanitized failure identity only from the exact Actions-owned review CheckRun. */
export function recordedReviewFailure(checkRuns, sourceRunId, repository) {
  const matches = (checkRuns || []).filter(check => check?.name === REVIEW_CHECK_NAME
    && check.app?.id === 15368
    && check.status === 'completed'
    && check.conclusion === 'failure'
    && reviewRunIdFromCheckRun(check, repository) === sourceRunId)
  if (matches.length !== 1) return null
  const match = /Failure class: (transport|auth-quota|protocol|task|host|permissions)\. Error code: ([A-Za-z0-9][A-Za-z0-9._-]{0,127})\./
    .exec(String(matches[0].output?.summary || ''))
  return match ? { failureClass: match[1], errorCode: match[2] } : null
}

/** Derive one exact root-fault observation from a trusted review infrastructure failure. */
export function observeReviewInfrastructureFault({ run, jobs, repository, trust }) {
  const reviewJobs = reviewWorkflowFailureJobs(jobs)
  if (trustedFailedAgentRun({ run, repository, trust }) !== 'review'
    || !reviewJobs
    || intentionalReviewBlock(run, reviewJobs)) return null
  const candidates = (run.pull_requests || []).filter(pullRequest => Number.isSafeInteger(pullRequest.number)
    && pullRequest.number > 0
    && FULL_SHA.test(pullRequest.base?.sha || '')
    && FULL_SHA.test(pullRequest.head?.sha || '')
    && pullRequest.head.sha === run.head_sha)
  if (candidates.length !== 1) return null
  const [{ number, base, head }] = candidates
  const failure = ['cancelled', 'timed_out', 'startup_failure', 'stale'].includes(run.conclusion)
    ? { failureClass: 'transport', errorCode: run.conclusion }
    : { failureClass: 'host', errorCode: 'review-infrastructure-failure' }
  return {
    repository,
    component: 'review-worker',
    operation: 'recover-review',
    ...failure,
    rootRequestIds: [`pull-request-${number}`],
    sourceRunId: run.id,
    subject: { type: 'pull-request', number, base: base.sha, head: head.sha },
  }
}

/** Verify that one target-repository run, rather than Issue prose, authorized a fault projection. */
export function trustedFaultProjectionRun({ issue, projection, run, trustedControllerRepository }) {
  if (issue?.user?.login !== 'github-actions[bot]'
    || projection?.repository !== issue?.repository_url?.split('/repos/').at(-1)
    || projection?.controllerRepository !== trustedControllerRepository
    || run?.repository?.full_name !== projection.repository
    || run.status !== 'completed'
    || run.conclusion !== 'success'
    || run.event !== 'workflow_run') return false
  return PROJECTION_WORKFLOW_PATHS.some(path => run.referenced_workflows?.some(reference => reference.path
    === `${projection.controllerRepository}/${path}@${projection.controllerSha}`
    && reference.sha === projection.controllerSha))
}
