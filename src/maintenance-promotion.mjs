import { evaluatePullRequestSize, measureGitHubPullRequestFiles } from './pull-request-size.mjs'
import { parseFaultRecord } from './fault-record.mjs'

const FULL_SHA = /^[0-9a-f]{40}$/

/**
 * Require every completed maintenance stage and the live pull request to use one exact head.
 * @param {{ record: object, currentHead: unknown, stages: string[] }} input
 * @returns {string}
 */
export function assertMaintenanceHeadContinuity(record, currentHead, stages) {
  const normalized = parseFaultRecord(record)
  if (!Array.isArray(stages) || stages.length < 1 || stages.some(stage => !['review', 'ci', 'promotion'].includes(stage))) {
    throw new Error('Maintenance head continuity stages are invalid')
  }
  if (!FULL_SHA.test(currentHead || '')) throw new Error('Maintenance pull request head is not a full commit SHA')
  let expectedHead
  for (const stage of stages) {
    const attempt = normalized.attempts.filter(candidate => candidate.epoch === normalized.epochs.at(-1).number
      && candidate.kind === stage && candidate.outcome === 'succeeded').at(-1)
    if (!FULL_SHA.test(attempt?.head || '')) throw new Error(`Maintenance ${stage} attempt has no exact PR head`)
    if (expectedHead !== undefined && attempt.head !== expectedHead) {
      throw new Error(`Maintenance ${stage} head drifted from the prior stage`)
    }
    expectedHead = attempt.head
  }
  if (expectedHead !== currentHead) throw new Error(`Maintenance pull request head drifted from ${stages.at(-1)} head`)
  return expectedHead
}

/** Decide whether one freshly read maintenance pull request may be promoted. */
/** @param {{ pull: { head?: { sha?: unknown }, body?: unknown }, files: unknown }} input @returns {{ expectedHead: string, body: string, message: string }} */
export function assessMaintenancePromotion({ pull, files }) {
  const expectedHead = pull.head?.sha
  if (!/^[0-9a-f]{40}$/.test(expectedHead || '')) throw new Error('Maintenance pull request head is not a full commit SHA')
  const size = evaluatePullRequestSize({
    ...measureGitHubPullRequestFiles(files),
    pullRequestBody: pull.body || '',
  })
  if (!size.accepted) throw new Error(`Maintenance pull request is not eligible for promotion: ${size.message}`)
  return { expectedHead, body: String(pull.body || ''), message: size.message }
}

/** Confirm that the pull request decision still binds the live PR immediately before merge. */
/** @param {{ decision: { expectedHead: string, body: string }, current: { state?: unknown, head?: { sha?: unknown }, body?: unknown } }} input */
export function confirmMaintenancePromotionHead({ decision, current }) {
  if (current.state !== 'open' || current.head?.sha !== decision.expectedHead
    || String(current.body || '') !== decision.body) {
    throw new Error('Maintenance pull request changed after its promotion decision')
  }
}
