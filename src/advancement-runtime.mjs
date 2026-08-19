// @ts-check

import { createHash } from 'node:crypto'

const MUTATIONS = new Set(['request-review', 'request-repair', 'request-landing'])
const TERMINAL_ACTIONS = new Set([
  'wait-review', 'wait-checks', 'paused', 'stale', 'terminal', 'noop',
])

/** @typedef {{ action: string, repository: string, pullRequestNumber: number, pair: { base: string, head: string }, stateVersion: string, workflow: { definitionHash: string, workflowId: string, stageId: string } }} AdvancementRequest */
/** @typedef {{ requestReview: (request: AdvancementRequest & { transitionIdentity: string }) => unknown, requestRepair: (request: AdvancementRequest & { transitionIdentity: string }) => unknown, requestLanding: (request: AdvancementRequest & { transitionIdentity: string }) => unknown }} AdvancementEffects */
/** @typedef {{ isApplied: (request: AdvancementRequest & { transitionIdentity: string }) => boolean | Promise<boolean>, markApplied: (request: AdvancementRequest & { transitionIdentity: string }) => unknown }} AdvancementJournal */

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
  })).digest('hex')
}

/**
 * Route a verified deterministic decision to its one mutation effect.
 * @param {AdvancementRequest} value
 * @param {AdvancementEffects} effects
 * @param {AdvancementJournal} [journal]
 * @returns {Promise<AdvancementRequest & { transitionIdentity: string, alreadyApplied?: boolean }>}
 */
export async function consumePullRequestAdvancement(value, effects, journal) {
  const request = requireRequest(value)
  const transitionIdentity = advancementTransitionIdentity(request)
  const output = { ...request, transitionIdentity }
  if (MUTATIONS.has(request.action) && journal && await journal.isApplied(output)) {
    return { ...output, alreadyApplied: true }
  }
  if (request.action === 'request-review') await effects.requestReview(output)
  if (request.action === 'request-repair') await effects.requestRepair(output)
  if (request.action === 'request-landing') await effects.requestLanding(output)
  if (MUTATIONS.has(request.action) && journal) await journal.markApplied(output)
  return output
}
