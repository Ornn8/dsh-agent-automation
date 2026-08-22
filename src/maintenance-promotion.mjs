import { evaluatePullRequestSize, measureGitHubPullRequestFiles } from './pull-request-size.mjs'

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
