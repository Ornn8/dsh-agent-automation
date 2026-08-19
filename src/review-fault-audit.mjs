import { observeReviewInfrastructureFault } from './fault-observation.mjs'
import {
  classifyControllerFailure,
  reviewWorkflowFailureSignature,
  reviewWorkflowFailureJobs,
  verifyAgentFailureRole,
  verifyReviewEvidenceDisagreement,
  verifyReviewInfrastructureFailureEvidence,
} from './failure-classification.mjs'
import { reviewRunIdFromCheckRun } from './landing-policy.mjs'
import { parseReviewCheckIdentity } from './review-check.mjs'
import { REVIEW_CHECK_NAME, REVIEW_WORKFLOW_PATH } from './review-authority.mjs'

const GITHUB_ACTIONS_APP_ID = 15368
const FULL_SHA = /^[0-9a-f]{40}$/
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0
}

/** Return the GitHub API paths that freeze one workflow attempt for fault observation. @param {string} repository @param {number} runId @param {number} runAttempt @returns {{run: string, jobs: string}} @throws {Error} Invalid attempt identity. */
export function reviewFaultAttemptEndpoints(repository, runId, runAttempt) {
  if (!REPOSITORY.test(repository || '') || !positiveInteger(runId) || !positiveInteger(runAttempt)) {
    throw new Error('Review fault attempt identity is invalid')
  }
  const prefix = `repos/${repository}/actions/runs/${runId}/attempts/${runAttempt}`
  return { run: prefix, jobs: `${prefix}/jobs` }
}

/** Verify that an attempt-specific API response still identifies the requested workflow attempt. @param {object} run @param {number} runId @param {number} runAttempt @returns {void} @throws {Error} The API returned another attempt. */
export function verifyReviewFaultAttempt(run, runId, runAttempt) {
  if (!positiveInteger(runId) || !positiveInteger(runAttempt)
    || run?.id !== runId || run.run_attempt !== runAttempt) {
    throw new Error('Review fault source run attempt changed')
  }
}

/** Return the exact pull-request subject carried by a pull-request-target review run. @param {object} run @param {string} repository @returns {{number: number, base: string, head: string} | null} */
export function reviewFaultSubject(run, repository) {
  if (run?.event !== 'pull_request_target'
    || run.repository?.full_name !== repository
    || run.head_repository?.full_name !== repository) return null
  const candidates = (run.pull_requests || []).filter(candidate => Number.isSafeInteger(candidate?.number)
    && candidate.number > 0
    && FULL_SHA.test(candidate.base?.sha || '')
    && FULL_SHA.test(candidate.head?.sha || '')
    && candidate.head.sha === run.head_sha)
  return candidates.length === 1
    ? { number: candidates[0].number, base: candidates[0].base.sha, head: candidates[0].head.sha }
    : null
}

function exactCurrentPullRequest(run, current, repository) {
  if (!Number.isSafeInteger(current?.number) || current.number < 1
    || current.state !== 'open'
    || !FULL_SHA.test(current.base?.sha || '')
    || !FULL_SHA.test(current.head?.sha || '')
    || current.head?.repo?.full_name !== repository) return null
  const pullRequest = {
    number: current.number,
    repository,
    state: 'OPEN',
    isDraft: Boolean(current.draft),
    baseRefName: String(current.base?.ref || ''),
    baseRefOid: current.base.sha,
    headRefOid: current.head.sha,
    mergeStateStatus: '',
    mergeable: null,
  }
  const subject = reviewFaultSubject(run, repository)
  return subject?.number === pullRequest.number
    && subject.base === pullRequest.baseRefOid
    && subject.head === pullRequest.headRefOid
    ? pullRequest : null
}

function unknownAudit(run, jobs) {
  return classifyControllerFailure({ run, jobs, provenance: null })
}

/**
 * Decide the auditable classification and optional infrastructure projection for one review run.
 *
 * @param {object} input Exact workflow, job, pull-request, and CheckRun snapshot.
 * @returns {{classification: object, observation: object | null, reason: string, failureSignature?: string}}
 */
export function reviewFaultAuditDecision({ run, jobs, repository, trust, current, checkRuns = [] }) {
  const provenance = verifyAgentFailureRole({ run, jobs, repository, trust })
  const preliminaryEvidence = verifyReviewInfrastructureFailureEvidence({ run, jobs, provenance })
  const preliminaryClassification = classifyControllerFailure({
    run,
    jobs,
    provenance,
    failureEvidence: preliminaryEvidence || undefined,
  })
  const pullRequest = exactCurrentPullRequest(run, current, repository)
  if (!pullRequest) return { classification: unknownAudit(run, jobs), observation: null, reason: 'stale pull request pair' }

  const exactReviewChecks = checkRuns.filter(check => check?.name === REVIEW_CHECK_NAME
    && check.app?.id === GITHUB_ACTIONS_APP_ID
    && check.head_sha === pullRequest.headRefOid
    && reviewRunIdFromCheckRun(check, repository) === run.id
    && Number.isSafeInteger(run.run_attempt)
    && run.run_attempt > 0
    && parseReviewCheckIdentity(check)?.runAttempt === run.run_attempt)
  if (exactReviewChecks.length > 1) {
    return { classification: unknownAudit(run, jobs), observation: null, reason: 'ambiguous exact-pair review checks' }
  }
  if (exactReviewChecks.length === 1) {
    const reviewProof = { run, checkRun: exactReviewChecks[0] }
    const disagreement = verifyReviewEvidenceDisagreement({
      run,
      jobs,
      provenance,
      pullRequest,
      reviewProof,
      trustedReview: {
        controllerRepository: trust.controllerRepository,
        controllerSha: trust.controllerSha,
        workflowPath: REVIEW_WORKFLOW_PATH,
      },
    })
    if (disagreement) {
      return {
        classification: classifyControllerFailure({ run, jobs, provenance, failureEvidence: disagreement }),
        observation: null,
        reason: 'authoritative review evidence disagrees',
      }
    }
  }

  const observed = observeReviewInfrastructureFault({ run, jobs, repository, trust })
  if (!observed) return { classification: preliminaryClassification, observation: null, reason: 'not an infrastructure fault' }
  const authoritativeJobs = reviewWorkflowFailureJobs(jobs)
  if (!authoritativeJobs) return { classification: unknownAudit(run, jobs), observation: null, reason: 'review job evidence changed' }
  if (observed.subject.number !== pullRequest.number
    || observed.subject.base !== pullRequest.baseRefOid
    || observed.subject.head !== pullRequest.headRefOid) {
    return { classification: unknownAudit(run, jobs), observation: null, reason: 'review observation pair changed' }
  }
  return {
    classification: preliminaryClassification,
    observation: observed,
    reason: 'qualified review infrastructure fault',
    failureSignature: reviewWorkflowFailureSignature(run, authoritativeJobs),
  }
}

/** Load one exact pull-request-target snapshot and decide its fault audit. @param {object} input Trusted run evidence and read-only GitHub readers. @returns {Promise<{classification: object, observation: object | null, reason: string}>} */
export async function loadReviewFaultAuditDecision({ run, jobs, repository, trust, readPullRequest, readCheckRuns }) {
  const subject = reviewFaultSubject(run, repository)
  if (!subject) return reviewFaultAuditDecision({ run, jobs, repository, trust, current: null, checkRuns: [] })
  const current = await readPullRequest(subject.number)
  const exact = current?.state === 'open'
    && current.base?.sha === subject.base
    && current.head?.sha === subject.head
    && current.head?.repo?.full_name === repository
  const checkRuns = exact ? await readCheckRuns(subject.head) : []
  return reviewFaultAuditDecision({ run, jobs, repository, trust, current, checkRuns })
}

/**
 * Emit the audit record before an optional fault mutation.
 *
 * @param {{classification: object, observation: object | null}} decision
 * @param {{writeAudit: (classification: object) => void, upsertFault: (observation: object) => Promise<number>}} effects
 * @returns {Promise<number | null>}
 */
export async function applyReviewFaultDecision(decision, effects) {
  effects.writeAudit(decision.classification)
  return decision.observation ? effects.upsertFault(decision.observation) : null
}
