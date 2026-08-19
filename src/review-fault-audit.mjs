import { observeReviewInfrastructureFault, recordedReviewFailure } from './fault-observation.mjs'
import {
  classifyControllerFailure,
  verifyAgentFailureRole,
  verifyRecordedReviewFailureEvidence,
  verifyReviewEvidenceDisagreement,
  verifyReviewInfrastructureFailureEvidence,
} from './failure-classification.mjs'
import { reviewRunIdFromCheckRun } from './landing-policy.mjs'
import { REVIEW_CHECK_NAME, REVIEW_WORKFLOW_PATH } from './review-authority.mjs'

const GITHUB_ACTIONS_APP_ID = 15368

function exactCurrentPullRequest(observation, current, repository) {
  if (current?.number !== observation.subject.number
    || current.state !== 'open'
    || current.base?.sha !== observation.subject.base
    || current.head?.sha !== observation.subject.head
    || current.head?.repo?.full_name !== repository) return null
  return {
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
}

function unknownAudit(run, jobs) {
  return classifyControllerFailure({ run, jobs, provenance: null })
}

/**
 * Decide the auditable classification and optional infrastructure projection for one review run.
 *
 * @param {object} input Exact workflow, job, pull-request, and CheckRun snapshot.
 * @returns {{classification: object, observation: object | null, reason: string}}
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
  const observed = observeReviewInfrastructureFault({ run, jobs, repository, trust })
  if (!observed) return { classification: preliminaryClassification, observation: null, reason: 'not an infrastructure fault' }

  const pullRequest = exactCurrentPullRequest(observed, current, repository)
  if (!pullRequest) return { classification: unknownAudit(run, jobs), observation: null, reason: 'stale pull request pair' }

  const exactReviewChecks = checkRuns.filter(check => check?.name === REVIEW_CHECK_NAME
    && check.app?.id === GITHUB_ACTIONS_APP_ID
    && check.head_sha === pullRequest.headRefOid
    && reviewRunIdFromCheckRun(check, repository) === run.id)
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

  const recorded = recordedReviewFailure(exactReviewChecks, run.id, repository)
  const recordedEvidence = verifyRecordedReviewFailureEvidence({
    run, jobs, provenance, checkRuns: exactReviewChecks, repository,
  })
  const classification = classifyControllerFailure({
    run,
    jobs,
    provenance,
    failureEvidence: recordedEvidence || preliminaryEvidence || undefined,
  })
  return {
    classification,
    observation: { ...observed, ...(recorded || {}) },
    reason: 'qualified review infrastructure fault',
  }
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
