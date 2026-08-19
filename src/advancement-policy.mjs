// @ts-check

import {
  classifyControllerFailure,
  verifyAgentFailureRole,
  verifyReviewEvidenceDisagreement,
  verifyReviewInfrastructureFailureEvidence,
} from './failure-classification.mjs'
import {
  hasTrustedExactReviewProof,
  hasTrustedExactReviewRun,
  requiredCheckStatus,
} from './landing-policy.mjs'
import { REVIEW_WORKFLOW_PATH } from './review-authority.mjs'
import { parseReviewCheckIdentity } from './review-check.mjs'
import { verifyReviewFaultJobs } from './review-fault-audit.mjs'

const SHA1 = /^[0-9a-f]{40}$/
const SHA256 = /^[0-9a-f]{64}$/
const ACTIONS = new Set([
  'request-review', 'wait-review', 'wait-checks', 'request-repair',
  'request-landing', 'paused', 'stale', 'terminal', 'noop',
])
const SUBJECT_STATES = new Set(['open', 'closed'])
const GOVERNOR_STATES = new Set(['idle', 'pending', 'running', 'completed', 'failed'])
const WAKE_EVENTS = new Set([
  'review.completed',
  'review.recovery.completed',
  'repair.completed',
  'recovery.completed',
  'pull-request.updated',
  'ci.required-check.completed',
])

/** @typedef {{ number: number, state: 'open' | 'closed', draft: boolean, baseRefName: string }} AdvancementPullRequest */
/** @typedef {{ base: string, head: string }} AdvancementPair */
/** @typedef {Record<string, unknown> & { id?: number, name?: string, head_sha?: string, status?: string, conclusion?: string, app?: { id?: number }, external_id?: string, details_url?: string }} ReviewCheckProof */
/** @typedef {Record<string, unknown> & { id: number, run_attempt?: number, event: string, status: string, conclusion?: string, head_sha: string, head_branch?: string, repository?: { full_name?: string }, head_repository?: { full_name?: string }, pull_requests?: Array<{ number?: number, base?: { sha?: string }, head?: { sha?: string } }>, referenced_workflows?: Array<{ path?: string, sha?: string }> }} ReviewWorkflowProof */
/** @typedef {{ state: 'missing' | 'pending', proof: null } | { state: 'completed', proof: { checkRun: ReviewCheckProof, run: ReviewWorkflowProof, jobs: Record<string, unknown>[] } }} AdvancementReview */
/** @typedef {string | { context: string, app_id?: number | null }} RequiredCheckDefinition */
/** @typedef {'review.completed' | 'review.recovery.completed' | 'repair.completed' | 'recovery.completed' | 'pull-request.updated' | 'ci.required-check.completed'} WakeEvent */
/** @typedef {{ required: RequiredCheckDefinition[], results: Record<string, unknown>[] }} AdvancementChecks */
/** @typedef {{ repair: 'idle' | 'pending' | 'running' | 'completed' | 'failed', recovery: 'idle' | 'pending' | 'running' | 'completed' | 'failed', paused: boolean }} AdvancementGovernor */
/** @typedef {{ definitionHash: string, workflowId: string, stageId: string }} AdvancementWorkflow */
/** @typedef {{ controllerRepository: string, controllerSha: string, workflowPath: string }} TrustedReview */
/** @typedef {{ repository: string, pullRequest: AdvancementPullRequest, defaultBranch: string, pair: AdvancementPair, expectedPair: AdvancementPair, mergeability: 'mergeable' | 'conflicting' | 'unknown', review: AdvancementReview, trustedReview: TrustedReview, checks: AdvancementChecks, governor: AdvancementGovernor, workflow: AdvancementWorkflow, stateVersion: string }} AdvancementSnapshot */
/** @typedef {'missing' | 'pending' | 'pass' | 'block' | 'infrastructure-failure' | 'untrusted'} DerivedReviewState */
/** @typedef {Record<string, unknown>} UnknownRecord */

/** @param {unknown} value @param {string} name @param {number} [maximum] @returns {string} */
function requireText(value, name, maximum = 200) {
  if (typeof value !== 'string' || value.length < 1 || value.length > maximum || /[\r\n]/.test(value)) {
    throw new Error(`${name} must be bounded text`)
  }
  return value
}

/** @param {unknown} value @param {string} name @param {RegExp} pattern @returns {string} */
function requireSha(value, name, pattern) {
  if (typeof value !== 'string' || !pattern.test(value)) throw new Error(`${name} must be a lowercase hexadecimal SHA`)
  return value
}

/** @param {unknown} value @param {string} name @returns {UnknownRecord} */
function requireObject(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} must be an object`)
  return /** @type {UnknownRecord} */ (value)
}

/** @param {unknown} pair @param {string} [name] @returns {AdvancementPair} */
function requireExactPair(pair, name = 'pair') {
  const object = requireObject(pair, name)
  const base = requireSha(object.base, `${name}.base`, SHA1)
  const head = requireSha(object.head, `${name}.head`, SHA1)
  if (base === head) throw new Error(`${name} must contain different base and head SHAs`)
  return { base, head }
}

/** @param {unknown} value @returns {AdvancementWorkflow} */
function normalizeWorkflow(value) {
  const object = requireObject(value, 'workflow')
  return {
    definitionHash: requireSha(object.definitionHash, 'workflow.definitionHash', SHA256),
    workflowId: requireText(object.workflowId, 'workflow.workflowId', 64),
    stageId: requireText(object.stageId, 'workflow.stageId', 64),
  }
}

/** @param {unknown} value @returns {TrustedReview} */
function normalizeTrustedReview(value) {
  const object = requireObject(value, 'trustedReview')
  const workflowPath = requireText(object.workflowPath, 'trustedReview.workflowPath')
  if (workflowPath !== REVIEW_WORKFLOW_PATH) throw new Error('trustedReview.workflowPath is not the canonical review workflow')
  return {
    controllerRepository: requireText(object.controllerRepository, 'trustedReview.controllerRepository'),
    controllerSha: requireSha(object.controllerSha, 'trustedReview.controllerSha', SHA1),
    workflowPath,
  }
}

/** @param {unknown} value @returns {AdvancementReview} */
function normalizeReview(value) {
  const object = requireObject(value, 'review')
  if (object.state === 'missing' || object.state === 'pending') {
    if (object.proof !== undefined && object.proof !== null) throw new Error('incomplete review state cannot carry proof')
    return { state: object.state, proof: null }
  }
  if (object.state !== 'completed') throw new Error('review state is invalid')
  const proof = requireObject(object.proof, 'review.proof')
  const checkRun = requireObject(proof.checkRun, 'review.proof.checkRun')
  const run = requireObject(proof.run, 'review.proof.run')
  if (!Array.isArray(proof.jobs) || proof.jobs.length > 100) throw new Error('review.proof.jobs must be a bounded array')
  return {
    state: 'completed',
    proof: {
      checkRun: /** @type {ReviewCheckProof} */ (checkRun),
      run: /** @type {ReviewWorkflowProof} */ (run),
      jobs: proof.jobs.map((job, index) => requireObject(job, `review.proof.jobs[${index}]`)),
    },
  }
}

/** @param {unknown} value @returns {AdvancementChecks} */
function normalizeChecks(value) {
  const object = requireObject(value, 'checks')
  if (!Array.isArray(object.required) || object.required.length < 1 || object.required.length > 32
    || !Array.isArray(object.results) || object.results.length > 256) {
    throw new Error('checks must contain bounded required definitions and results')
  }
  /** @type {RequiredCheckDefinition[]} */
  const required = object.required.map((value, index) => {
    if (typeof value === 'string') return requireText(value, `checks.required[${index}]`, 128)
    const item = requireObject(value, `checks.required[${index}]`)
    const context = requireText(item.context, `checks.required[${index}].context`, 128)
    const appId = /** @type {number|null|undefined} */ (item.app_id)
    if (appId !== undefined && appId !== null && (!Number.isSafeInteger(appId) || appId < 1)) throw new Error('required check app_id is invalid')
    return { context, ...(appId === undefined ? {} : { app_id: appId }) }
  })
  const requiredIdentities = required.map(item => typeof item === 'string' ? `${item}:` : `${item.context}:${item.app_id ?? ''}`)
  if (new Set(requiredIdentities).size !== required.length) throw new Error('checks.required must not contain duplicates')
  const results = object.results.map((value, index) => requireObject(value, `checks.results[${index}]`))
  const ids = results.map(result => result.id)
  if (ids.some(id => !Number.isSafeInteger(id) || Number(id) < 1) || new Set(ids).size !== ids.length) {
    throw new Error('check result ids must be unique positive integers')
  }
  return { required, results }
}

/** Validate and normalize one complete exact-state advancement snapshot. @param {unknown} value @returns {AdvancementSnapshot} */
function normalizeSnapshot(value) {
  const object = requireObject(value, 'advancement snapshot')
  const pullRequest = requireObject(object.pullRequest, 'pullRequest')
  const number = /** @type {number} */ (pullRequest.number)
  const state = /** @type {string} */ (pullRequest.state)
  const baseRefName = requireText(pullRequest.baseRefName, 'pullRequest.baseRefName')
  const defaultBranch = requireText(object.defaultBranch, 'defaultBranch', 128)
  if (!Number.isSafeInteger(number) || number < 1 || !SUBJECT_STATES.has(state) || typeof pullRequest.draft !== 'boolean') {
    throw new Error('pullRequest state is invalid')
  }
  if (baseRefName !== defaultBranch) throw new Error('pullRequest baseRefName must equal defaultBranch')
  const governor = requireObject(object.governor, 'governor')
  const repair = /** @type {string} */ (governor.repair)
  const recovery = /** @type {string} */ (governor.recovery)
  const mergeability = /** @type {string} */ (object.mergeability)
  if (!GOVERNOR_STATES.has(repair) || !GOVERNOR_STATES.has(recovery) || typeof governor.paused !== 'boolean') {
    throw new Error('governor state is invalid')
  }
  if (!['mergeable', 'conflicting', 'unknown'].includes(mergeability)) throw new Error('mergeability is invalid')
  return {
    repository: requireText(object.repository, 'repository', 200),
    pullRequest: { number, state: /** @type {'open'|'closed'} */ (state), draft: /** @type {boolean} */ (pullRequest.draft), baseRefName },
    defaultBranch,
    pair: requireExactPair(object.pair),
    expectedPair: requireExactPair(object.expectedPair, 'expectedPair'),
    mergeability: /** @type {AdvancementSnapshot['mergeability']} */ (mergeability),
    review: normalizeReview(object.review),
    trustedReview: normalizeTrustedReview(object.trustedReview),
    checks: normalizeChecks(object.checks),
    governor: {
      repair: /** @type {AdvancementGovernor['repair']} */ (repair),
      recovery: /** @type {AdvancementGovernor['recovery']} */ (recovery),
      paused: /** @type {boolean} */ (governor.paused),
    },
    workflow: normalizeWorkflow(object.workflow),
    stateVersion: requireSha(object.stateVersion, 'stateVersion', SHA256),
  }
}

/** @param {AdvancementSnapshot} snapshot */
function landingPullRequest(snapshot) {
  return {
    number: snapshot.pullRequest.number,
    repository: snapshot.repository,
    state: snapshot.pullRequest.state.toUpperCase(),
    isDraft: snapshot.pullRequest.draft,
    baseRefName: snapshot.pullRequest.baseRefName,
    baseRefOid: snapshot.pair.base,
    headRefOid: snapshot.pair.head,
    mergeStateStatus: snapshot.mergeability.toUpperCase(),
    mergeable: snapshot.mergeability === 'mergeable' ? true : snapshot.mergeability === 'conflicting' ? false : null,
  }
}

/** Derive review authority only from controller-verified machine evidence. @param {AdvancementSnapshot} snapshot @returns {DerivedReviewState} */
function reviewState(snapshot) {
  if (snapshot.review.state !== 'completed') return snapshot.review.state
  const { checkRun, run, jobs } = snapshot.review.proof
  const identity = parseReviewCheckIdentity(checkRun)
  if (!identity || identity.workflowId !== snapshot.workflow.workflowId
    || identity.stageId !== snapshot.workflow.stageId
    || identity.definitionHash !== snapshot.workflow.definitionHash
    || identity.runId !== run.id || identity.runAttempt !== run.run_attempt
    || checkRun.head_sha !== snapshot.pair.head) return 'untrusted'
  verifyReviewFaultJobs(jobs, run.id, run.run_attempt)
  const pullRequest = landingPullRequest(snapshot)
  const reviewProof = { checkRun, run }
  if (!hasTrustedExactReviewRun({ pullRequest, reviewProof, trustedReview: snapshot.trustedReview })) return 'untrusted'
  if (hasTrustedExactReviewProof({ pullRequest, reviewProof, trustedReview: snapshot.trustedReview })) return 'pass'
  const provenance = verifyAgentFailureRole({ run, jobs, repository: snapshot.repository, trust: snapshot.trustedReview })
  if (!provenance) return 'untrusted'
  const disagreementEvidence = verifyReviewEvidenceDisagreement({
    run, jobs, provenance, pullRequest, reviewProof, trustedReview: snapshot.trustedReview,
  })
  if (disagreementEvidence) return 'untrusted'
  const infrastructureEvidence = verifyReviewInfrastructureFailureEvidence({ run, jobs, provenance })
  const classification = classifyControllerFailure({
    run,
    jobs,
    provenance,
    ...(infrastructureEvidence ? { failureEvidence: infrastructureEvidence } : {}),
  })
  if (classification.category === 'review') return 'block'
  if (classification.category === 'ci-environment') return 'infrastructure-failure'
  return 'untrusted'
}

/** @param {AdvancementSnapshot} snapshot */
function identity(snapshot) {
  return { pair: { ...snapshot.pair }, stateVersion: snapshot.stateVersion, workflow: { ...snapshot.workflow } }
}

/** @param {AdvancementSnapshot} snapshot @param {string} action @param {string} reason @param {Record<string, unknown>} [extra] */
function decision(snapshot, action, reason, extra = {}) {
  if (!ACTIONS.has(action)) throw new Error(`unsupported advancement action ${action}`)
  return { action, reason, ...extra, ...identity(snapshot) }
}

/** @param {AdvancementSnapshot} snapshot @param {string} action @param {string} reason @param {string} missingCondition @param {WakeEvent[]} wakeEvents @param {boolean} [scheduledReconciliation] */
function waitDecision(snapshot, action, reason, missingCondition, wakeEvents, scheduledReconciliation = true) {
  if (wakeEvents.some(event => !WAKE_EVENTS.has(event))) throw new Error('unsupported wake event')
  return decision(snapshot, action, reason, { missingCondition, wakeEvents, scheduledReconciliation })
}

/** Decide exactly one next pull-request advancement action without performing any mutation. @param {AdvancementSnapshot} value @returns {Record<string, unknown>} @throws {Error} Malformed snapshot. */
export function decidePullRequestAdvancement(value) {
  const snapshot = normalizeSnapshot(value)
  if (snapshot.pair.base !== snapshot.expectedPair.base || snapshot.pair.head !== snapshot.expectedPair.head) {
    return decision(snapshot, 'stale', 'the requested exact base/head pair is no longer current', { expectedPair: snapshot.expectedPair })
  }
  if (snapshot.pullRequest.state !== 'open') return decision(snapshot, 'terminal', 'pull request is closed')
  if (snapshot.pullRequest.draft) return decision(snapshot, 'terminal', 'pull request is draft')
  if (snapshot.governor.paused) return decision(snapshot, 'paused', 'Governor automation is paused')
  if (snapshot.governor.repair === 'failed' || snapshot.governor.recovery === 'failed') {
    return decision(snapshot, 'paused', 'Governor repair or recovery failed and requires bounded recovery')
  }
  if (snapshot.governor.repair === 'pending' || snapshot.governor.repair === 'running') {
    return waitDecision(snapshot, 'wait-checks', 'Governor repair is active', 'repair-completed', ['repair.completed'])
  }
  if (snapshot.governor.recovery === 'pending' || snapshot.governor.recovery === 'running') {
    return waitDecision(snapshot, 'wait-review', 'Governor recovery is active', 'recovery-completed', ['recovery.completed'])
  }
  const review = reviewState(snapshot)
  const statuses = snapshot.checks.required.map(required => requiredCheckStatus(
    snapshot.checks.results.filter(check => check.head_sha === snapshot.pair.head), required,
  ))
  if (review === 'infrastructure-failure') {
    return waitDecision(snapshot, 'wait-review', 'review infrastructure recovery is pending', 'review-infrastructure-recovery', ['review.recovery.completed'])
  }
  if (review === 'block') return decision(snapshot, 'request-repair', 'trusted review BLOCK requires repair')
  if (review === 'untrusted') {
    return waitDecision(snapshot, 'wait-review', 'review evidence is not authoritative for this exact pair', 'trusted-exact-pair-review', ['review.completed'])
  }
  if (snapshot.mergeability === 'conflicting') return decision(snapshot, 'request-repair', 'pull request has a merge conflict')
  if (snapshot.mergeability === 'unknown') {
    return waitDecision(snapshot, 'wait-checks', 'GitHub has not resolved mergeability', 'resolved-mergeability', ['pull-request.updated'])
  }
  if (statuses.some(status => status === 'failed')) return decision(snapshot, 'request-repair', 'a required exact-head check failed')
  if (review !== 'pass') {
    if (review === 'missing' && !statuses.every(status => status === 'passed')) {
      return decision(snapshot, 'request-review', 'no review is active for the exact pair')
    }
    return waitDecision(snapshot, 'wait-review', 'trusted exact-pair review is missing', 'trusted-exact-pair-review', ['review.completed'])
  }
  if (statuses.some(status => status !== 'passed')) {
    return waitDecision(snapshot, 'wait-checks', 'required exact-head checks are incomplete', 'required-exact-head-checks', ['ci.required-check.completed'])
  }
  return decision(snapshot, 'request-landing', 'trusted review and required exact-head checks passed')
}
