// @ts-check

import { createHash } from 'node:crypto'
import { governorDecision, unappliedGovernorCandidate } from './governor-policy.mjs'
import { mergeRepairTransition, reviewRepairTransition } from './work-request.mjs'

const MUTATIONS = new Set(['request-review', 'request-repair', 'request-landing'])
const TERMINAL_ACTIONS = new Set([
  'wait-review', 'wait-checks', 'paused', 'stale', 'terminal', 'noop',
])

/** @typedef {{ action: string, repository: string, pullRequestNumber: number, pair: { base: string, head: string }, stateVersion: string, workflow: { definitionHash: string, workflowId: string, stageId: string }, repair?: { cause?: string, candidate?: { transition: string, observationId: string } | null }, review?: { rereview?: boolean } }} AdvancementRequest */
/** @typedef {{ requestReview: (request: AdvancementRequest & { transitionIdentity: string }) => unknown, requestRepair: (request: AdvancementRequest & { transitionIdentity: string }) => unknown, requestLanding: (request: AdvancementRequest & { transitionIdentity: string }) => unknown }} AdvancementEffects */
/** @typedef {{ claim: (request: AdvancementRequest & { transitionIdentity: string }) => boolean | Promise<boolean>, markInflight?: (request: AdvancementRequest & { transitionIdentity: string }) => unknown, markApplied: (request: AdvancementRequest & { transitionIdentity: string }) => unknown }} AdvancementJournal */
/** @typedef {{ status?: string, transition?: string, stateVersion?: string, subject?: { type?: string, number?: number } }} GovernorRecord */
/** @typedef {{ type: 'pull-request', number: number, state: string, draft: boolean, base: string, head: string, labels?: unknown[] }} RepairSubject */

/** @param {unknown} value @returns {string} */
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    const object = /** @type {Record<string, unknown>} */ (value)
    return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

/** @param {unknown} value @returns {AdvancementRequest} */
function requireRequest(value) {
  if (!value || typeof value !== 'object') throw new Error('advancement request identity is incomplete')
  const request = /** @type {Partial<AdvancementRequest>} */ (value)
  if (typeof request.repository !== 'string' || !request.repository
    || typeof request.pullRequestNumber !== 'number'
    || !Number.isSafeInteger(request.pullRequestNumber) || request.pullRequestNumber < 1
    || !/^[0-9a-f]{40}$/.test(request.pair?.base || '')
    || !/^[0-9a-f]{40}$/.test(request.pair?.head || '')
    || !/^[0-9a-f]{64}$/.test(request.stateVersion || '')
    || !/^[0-9a-f]{64}$/.test(request.workflow?.definitionHash || '')
    || typeof request.workflow?.workflowId !== 'string' || !request.workflow.workflowId
    || typeof request.workflow?.stageId !== 'string' || !request.workflow.stageId) {
    throw new Error('advancement request identity is incomplete')
  }
  if (typeof request.action !== 'string'
    || (!MUTATIONS.has(request.action) && !TERMINAL_ACTIONS.has(request.action))) {
    throw new Error(`unsupported advancement action ${request.action}`)
  }
  if (request.repair !== undefined) {
    if (!request.repair || typeof request.repair !== 'object'
      || (request.repair.cause !== undefined && (typeof request.repair.cause !== 'string' || !request.repair.cause))
      || (request.repair.candidate !== undefined && request.repair.candidate !== null
        && (typeof request.repair.candidate !== 'object'
          || typeof request.repair.candidate.transition !== 'string'
          || typeof request.repair.candidate.observationId !== 'string'))) {
      throw new Error('advancement repair generation is invalid')
    }
  }
  if (request.review !== undefined && (!request.review || request.review.rereview !== true)) {
    throw new Error('Advancement review generation is invalid')
  }
  return /** @type {AdvancementRequest} */ (request)
}

/**
 * Return the stable identity for one exact-pair advancement transition.
 * @param {AdvancementRequest} value
 * @returns {string}
 */
export function advancementTransitionIdentity(value) {
  const request = requireRequest(value)
  return createHash('sha256').update(canonicalJson({
    repository: request.repository,
    pullRequestNumber: request.pullRequestNumber,
    pair: request.pair,
    workflow: request.workflow,
    stateVersion: request.stateVersion,
    transition: request.action,
    ...(request.action === 'request-repair' ? { repair: request.repair || null } : {}),
    ...(request.action === 'request-review' ? { review: request.review || null } : {}),
  })).digest('hex')
}

/**
 * Reuse one exact requested repair or create its decision-bound Governor candidate.
 * @param {{ records: GovernorRecord[], subject: RepairSubject, stateVersion: string, transitionIdentity: string, repairCause?: string }} input
 * @returns {{ transition: string, record: object | null }}
 */
export function advancementRepairCandidate({ records, subject, stateVersion, transitionIdentity, repairCause }) {
  if (!Array.isArray(records) || !/^[0-9a-f]{64}$/.test(transitionIdentity || '')) {
    throw new Error('Advancement repair identity is incomplete')
  }
  const observationId = `advance-${transitionIdentity}`
  const transition = repairCause === 'merge-conflict'
    ? mergeRepairTransition(observationId)
    : reviewRepairTransition(observationId)
  const existing = unappliedGovernorCandidate(records, /** @param {GovernorRecord} record */ record =>
    record.transition === transition
    && record.stateVersion === stateVersion
    && record.subject?.type === subject?.type
    && record.subject?.number === subject?.number)
  if (existing) return { transition, record: null }
  const repair = governorDecision({
    transition,
    subject,
    stateVersion,
    observationId,
    records,
    resumeCondition: undefined,
  })
  if (!repair.record || repair.action !== 'record-candidate') {
    throw new Error(`Advancement could not claim exact-pair repair: ${repair.action}`)
  }
  return { transition, record: repair.record }
}

/**
 * Route a verified deterministic decision to its one mutation effect.
 * @param {AdvancementRequest} value
 * @param {AdvancementEffects} effects
 * @param {AdvancementJournal} [journal]
 * @returns {Promise<AdvancementRequest & { transitionIdentity: string, alreadyApplied?: boolean, deferred?: boolean }>}
 */
export async function consumePullRequestAdvancement(value, effects, journal) {
  const request = requireRequest(value)
  const transitionIdentity = advancementTransitionIdentity(request)
  const output = { ...request, transitionIdentity }
  if (MUTATIONS.has(request.action) && journal && !await journal.claim(output)) {
    return { ...output, alreadyApplied: true }
  }
  if ((request.action === 'request-review' || request.action === 'request-repair') && journal?.markInflight) {
    await journal.markInflight(output)
  }
  /** @type {unknown} */
  let effectResult
  if (request.action === 'request-review') effectResult = await effects.requestReview(output)
  if (request.action === 'request-repair') effectResult = await effects.requestRepair(output)
  if (request.action === 'request-landing') effectResult = await effects.requestLanding(output)
  if (request.action === 'request-landing' && effectResult && typeof effectResult === 'object'
    && /** @type {{ outcome?: unknown }} */ (effectResult).outcome === 'deferred') {
    return { ...output, deferred: true }
  }
  if (request.action === 'request-landing' && journal?.markInflight) {
    await journal.markInflight(output)
  }
  if (MUTATIONS.has(request.action) && journal) {
    let lastError
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        await journal.markApplied(output)
        lastError = null
        break
      } catch (error) {
        lastError = error
      }
    }
    if (lastError) throw lastError
  }
  return output
}
