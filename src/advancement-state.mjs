// @ts-check

import { subjectStateVersion } from './governor-policy.mjs'
import { pullRequestGovernorSubject } from './governor-state.mjs'
import {
  hasTrustedExactReviewInvocation,
  normalizeMergeableStatus,
  reviewRunIdFromCheckRun,
} from './landing-policy.mjs'
import { parseReviewCheckIdentity } from './review-check.mjs'
import { REVIEW_CHECK_NAME } from './review-authority.mjs'
import { resolveGithubPrCycle } from './github-pr-cycle.mjs'

const FULL_SHA = /^[0-9a-f]{40}$/

/** @typedef {{ status?: string, transition?: string, stateVersion?: string, subject?: { type?: string, number?: number } }} GovernorRecord */
/** @typedef {{ number: number, state: 'open' | 'closed', draft: boolean, mergeable?: boolean | string | null, base: { ref: string, sha: string }, head: { ref: string, sha: string, repo?: { full_name?: string } }, labels?: Array<string | { name?: string }> }} PullRequest */
/** @typedef {Record<string, unknown> & { id?: number, name?: string, head_sha?: string, status?: string, run_attempt?: number }} EvidenceRecord */
/** @typedef {{ definition: object, definitionHash: string }} WorkflowProfile */
/** @typedef {{ controllerRepository: string, controllerSha: string, workflowPath: string }} TrustedReview */
/** @typedef {{ repository: string, pullRequest: PullRequest, defaultBranch: string, expectedPair?: { base?: string, head?: string }, profile: WorkflowProfile, requestedWorkflowId?: string, trustedReview: TrustedReview, requiredChecks: Array<string | { context: string, app_id?: number | null }>, checkResults: EvidenceRecord[], governorRecords: GovernorRecord[], readRun: (runId: number) => Promise<EvidenceRecord>, readJobs: (runId: number, runAttempt: number) => Promise<Record<string, unknown>[]> }} AdvancementStateInput */

/** @param {GovernorRecord[]} records @param {number} pullRequestNumber */
function activeEpoch(records, pullRequestNumber) {
  const relevant = records.filter(record => record?.subject?.type === 'pull-request'
    && record.subject.number === pullRequestNumber)
  let start = 0
  let paused = false
  for (const [index, record] of relevant.entries()) {
    if (record.status === 'paused') paused = true
    if (record.status === 'resumed') {
      paused = false
      start = index + 1
    }
  }
  return { records: relevant.slice(start), paused }
}

/** @param {GovernorRecord[]} records @param {string} stateVersion @param {(transition: string) => boolean} predicate @param {boolean} requested @returns {'idle' | 'requested' | 'pending' | 'running'} */
function transitionState(records, stateVersion, predicate, requested) {
  const matching = records.filter(record => record.stateVersion === stateVersion && predicate(record.transition || ''))
  if (matching.some(record => record.status === 'applied' || record.status === 'attempt')) return 'running'
  if (matching.some(record => record.status === 'admitted')) return 'pending'
  if (matching.some(record => record.status === 'candidate')) return requested ? 'requested' : 'pending'
  return 'idle'
}

/**
 * Project durable Governor records into the closed PR advancement states.
 * @param {object[]} records
 * @param {number} pullRequestNumber
 * @param {string} stateVersion
 * @returns {{ repair: 'idle' | 'requested' | 'pending' | 'running', recovery: 'idle' | 'pending' | 'running', paused: boolean }}
 */
export function advancementGovernorState(records, pullRequestNumber, stateVersion) {
  const epoch = activeEpoch(records, pullRequestNumber)
  const recovery = transitionState(epoch.records, stateVersion, transition => transition === 'workflow-recovery', false)
  if (recovery === 'requested') throw new Error('Recovery candidate projection is invalid')
  return {
    repair: transitionState(epoch.records, stateVersion, transition => transition === 'review-repair' || transition.startsWith('review-repair:'), true),
    recovery,
    paused: epoch.paused,
  }
}

/** @param {{ base?: string, head?: string } | undefined} value @param {{ base: string, head: string }} fallback */
function exactPair(value, fallback) {
  const base = value?.base
  const head = value?.head
  return {
    base: typeof base === 'string' && FULL_SHA.test(base) ? base : fallback.base,
    head: typeof head === 'string' && FULL_SHA.test(head) ? head : fallback.head,
  }
}

/**
 * Build one complete raw exact-state input for the deterministic advancement evaluator.
 * @param {AdvancementStateInput} input
 * @returns {Promise<object>}
 */
export async function buildPullRequestAdvancementSnapshot({
  repository,
  pullRequest,
  defaultBranch,
  expectedPair,
  profile,
  requestedWorkflowId,
  trustedReview,
  requiredChecks,
  checkResults,
  governorRecords,
  readRun,
  readJobs,
}) {
  const pair = { base: pullRequest.base.sha, head: pullRequest.head.sha }
  const candidates = checkResults
    .filter(check => check?.name === REVIEW_CHECK_NAME && check.head_sha === pair.head)
    .sort((left, right) => Number(right.id || 0) - Number(left.id || 0))
  const workflowId = requestedWorkflowId || 'default'
  const cycle = resolveGithubPrCycle(profile.definition, workflowId)
  /** @type {{ state: 'missing' | 'pending', proof: null } | { state: 'completed', proof: { checkRun: EvidenceRecord, run: EvidenceRecord, jobs: Record<string, unknown>[] } }} */
  let review = { state: 'missing', proof: null }
  const landingPullRequest = {
    number: pullRequest.number,
    repository,
    state: pullRequest.state.toUpperCase(),
    isDraft: Boolean(pullRequest.draft),
    baseRefName: pullRequest.base.ref,
    baseRefOid: pair.base,
    headRefOid: pair.head,
    mergeStateStatus: 'UNKNOWN',
    mergeable: null,
  }
  for (const checkRun of candidates) {
    const identity = parseReviewCheckIdentity(checkRun)
    if (!identity || identity.workflowId !== workflowId
      || identity.stageId !== cycle.review.id
      || identity.definitionHash !== profile.definitionHash) continue
    const runId = reviewRunIdFromCheckRun(checkRun, repository)
    if (!runId || runId !== identity.runId) continue
    let run
    try {
      run = await readRun(runId)
    } catch {
      // An unreadable same-name candidate is not authoritative review evidence.
      continue
    }
    if (run?.run_attempt !== identity.runAttempt
      || !hasTrustedExactReviewInvocation({
        pullRequest: landingPullRequest,
        reviewProof: { checkRun, run: /** @type {import('./landing-policy.mjs').WorkflowRun} */ (run) },
        trustedReview,
      })) continue
    if (String(checkRun.status).toUpperCase() !== 'COMPLETED' || run.status !== 'completed') {
      review = { state: 'pending', proof: null }
      break
    }
    try {
      const jobs = await readJobs(runId, identity.runAttempt)
      review = { state: 'completed', proof: { checkRun, run, jobs } }
      break
    } catch {
      // A malformed same-name candidate cannot mask an older authoritative proof.
    }
  }
  const subject = pullRequestGovernorSubject(pullRequest)
  const stateVersion = subjectStateVersion(subject)
  const mergeable = normalizeMergeableStatus(pullRequest.mergeable)
  return {
    repository,
    pullRequest: {
      number: pullRequest.number,
      state: pullRequest.state,
      draft: Boolean(pullRequest.draft),
      baseRefName: pullRequest.base.ref,
    },
    defaultBranch,
    pair,
    expectedPair: exactPair(expectedPair, pair),
    mergeability: mergeable === true ? 'mergeable' : mergeable === false ? 'conflicting' : 'unknown',
    review,
    trustedReview,
    checks: { required: requiredChecks, results: checkResults },
    governor: advancementGovernorState(governorRecords, pullRequest.number, stateVersion),
    workflow: {
      definitionHash: profile.definitionHash,
      workflowId,
      stageId: cycle.review.id,
    },
    stateVersion,
  }
}
