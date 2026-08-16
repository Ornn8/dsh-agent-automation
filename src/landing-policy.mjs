// @ts-check

import { REVIEW_CHECK_NAME } from './review-authority.mjs'
import { parseReviewCheckIdentity } from './review-check.mjs'

const GITHUB_ACTIONS_APP_ID = 15368

/** @typedef {{ id?: number, __typename?: string, context?: string, name?: string, state?: string, status?: string, conclusion?: string, app?: { id?: number }, external_id?: string, details_url?: string }} RepositoryCheck */
/** @typedef {{ number: number, repository: string, state: string, isDraft: boolean, baseRefName: string, baseRefOid: string, headRefOid: string, mergeStateStatus: string }} LandingPullRequest */
/** @typedef {{ id: number, event: string, status: string, conclusion?: string, head_sha: string, head_branch?: string, repository?: { full_name?: string }, head_repository?: { full_name?: string }, pull_requests?: Array<{ number?: number, base?: { sha?: string }, head?: { sha?: string } }>, referenced_workflows?: Array<{ path?: string, sha?: string }> }} WorkflowRun */
/** @typedef {{ checkRun: RepositoryCheck, run: WorkflowRun }} ReviewProof */
/** @typedef {{ controllerRepository: string, controllerSha: string, workflowPath: string }} TrustedReview */

/** @param {RepositoryCheck} check */
function checkName(check) {
  return check.__typename === 'StatusContext' ? check.context : check.name
}

/** @param {RepositoryCheck} check */
function checkPassed(check) {
  if (check.__typename === 'StatusContext') return String(check.state).toUpperCase() === 'SUCCESS'
  return String(check.status).toUpperCase() === 'COMPLETED'
    && ['SUCCESS', 'SKIPPED', 'NEUTRAL'].includes(String(check.conclusion).toUpperCase())
}

/** @param {string | { context?: string, app_id?: number | null }} required */
function requiredCheckName(required) {
  return typeof required === 'string' ? required : required?.context
}

/**
 * @param {RepositoryCheck[]} checkRuns
 * @param {string | { context?: string, app_id?: number | null }} required
 */
function latestRequiredCheck(checkRuns, required) {
  const name = requiredCheckName(required)
  const appId = typeof required === 'object' ? required?.app_id : null
  return checkRuns
    .filter(check => checkName(check) === name
      && (appId === null || appId === undefined || check.app?.id === appId))
    .sort((left, right) => (right.id ?? 0) - (left.id ?? 0))[0]
}

/** Return the Actions run id only for a check URL belonging to this repository. */
/** @param {unknown} value @param {unknown} repository @returns {number | null} */
export function reviewRunIdFromDetailsUrl(value, repository) {
  if (typeof value !== 'string' || typeof repository !== 'string') return null
  const match = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/actions\/runs\/(\d+)(?:\/|$)/.exec(value)
  if (!match || match[1] !== repository) return null
  const runId = Number.parseInt(match[2], 10)
  return Number.isSafeInteger(runId) && runId > 0 ? runId : null
}

/** Return the trusted workflow candidate encoded by a controller-created CheckRun. */
/** @param {RepositoryCheck} checkRun @param {string} repository @returns {number | null} */
export function reviewRunIdFromCheckRun(checkRun, repository) {
  return parseReviewCheckIdentity(checkRun)?.runId
    || reviewRunIdFromDetailsUrl(checkRun?.external_id, repository)
    || reviewRunIdFromDetailsUrl(checkRun?.details_url, repository)
}

/** @param {WorkflowRun} run @param {LandingPullRequest} pullRequest @param {string} repository */
function hasExactPullRequest(run, pullRequest, repository) {
  if (run?.repository?.full_name !== repository
    || run.head_repository?.full_name !== repository
    || run.status !== 'completed'
    || !run.head_sha) return false
  if (run.event === 'repository_dispatch') {
    return run.head_sha === pullRequest.baseRefOid
      && typeof pullRequest.baseRefName === 'string'
      && pullRequest.baseRefName.length > 0
      && run.head_branch === pullRequest.baseRefName
  }
  return run.event === 'pull_request_target'
    && run.head_sha === pullRequest.headRefOid
    && run.pull_requests?.some(candidate => candidate.number === pullRequest.number
      && candidate.base?.sha === pullRequest.baseRefOid
      && candidate.head?.sha === pullRequest.headRefOid)
}

/** @param {WorkflowRun} run @param {TrustedReview} trustedReview */
function referencesTrustedController(run, trustedReview) {
  const expectedPath = `${trustedReview.controllerRepository}/${trustedReview.workflowPath}@${trustedReview.controllerSha}`
  return run?.referenced_workflows?.some(reference => reference.path === expectedPath
    && reference.sha === trustedReview.controllerSha)
}

/** Verify a completed review CheckRun against its immutable reusable-workflow provenance. */
/** @param {{ pullRequest: LandingPullRequest, reviewProof?: ReviewProof | null, trustedReview?: TrustedReview | null }} input */
export function hasTrustedExactReviewRun({ pullRequest, reviewProof, trustedReview }) {
  const checkRun = reviewProof?.checkRun
  const run = reviewProof?.run
  if (!checkRun || !run || !trustedReview) return false
  return checkRun.name === REVIEW_CHECK_NAME
    && String(checkRun.status).toUpperCase() === 'COMPLETED'
    && checkRun.app?.id === GITHUB_ACTIONS_APP_ID
    && reviewRunIdFromCheckRun(checkRun, pullRequest.repository) === run.id
    && hasExactPullRequest(run, pullRequest, pullRequest.repository)
    && referencesTrustedController(run, trustedReview)
}

/** Verify a successful exact-pair review against immutable Actions provenance. */
/** @param {{ pullRequest: LandingPullRequest, reviewProof?: ReviewProof | null, trustedReview?: TrustedReview | null }} input */
export function hasTrustedExactReviewProof({ pullRequest, reviewProof, trustedReview }) {
  if (!reviewProof || !hasTrustedExactReviewRun({ pullRequest, reviewProof, trustedReview })) return false
  return String(reviewProof.checkRun.conclusion).toUpperCase() === 'SUCCESS'
    && reviewProof.run.conclusion === 'success'
}

/** Decide whether a pull request is ready for the privileged landing operation. */
/** @param {{ pullRequest: LandingPullRequest, expectedHead: string, requiredChecks: Array<string | { context?: string, app_id?: number | null }>, checkRuns?: RepositoryCheck[], reviewProof?: ReviewProof | null, trustedReview?: TrustedReview | null }} input */
export function evaluateLanding({ pullRequest, expectedHead, requiredChecks, checkRuns = [], reviewProof, trustedReview }) {
  if (pullRequest.state !== 'OPEN' || pullRequest.isDraft) {
    return { ready: false, reason: 'pull request is not open and ready' }
  }
  if (pullRequest.headRefOid !== expectedHead) {
    return { ready: false, reason: 'pull request head changed' }
  }
  if (pullRequest.mergeStateStatus !== 'CLEAN') {
    return { ready: false, reason: `merge state is ${pullRequest.mergeStateStatus}` }
  }
  if (!hasTrustedExactReviewProof({ pullRequest, reviewProof, trustedReview })) {
    return { ready: false, reason: 'no trusted exact-pair Agent PASS exists' }
  }
  for (const required of requiredChecks) {
    const latest = latestRequiredCheck(checkRuns, required)
    if (!latest || !checkPassed(latest)) {
      return { ready: false, reason: `required check ${requiredCheckName(required)} has not passed` }
    }
  }
  return { ready: true, reason: 'exact review and required checks passed' }
}
