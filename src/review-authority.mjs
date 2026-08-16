// @ts-check

/** Canonical GitHub CheckRun name for an exact-pair Agent review. */
export const REVIEW_CHECK_NAME = 'agent/review'

/** Canonical reusable-workflow path trusted as Agent review provenance. */
export const REVIEW_WORKFLOW_PATH = '.github/workflows/agent-review.yml'

/** Canonical repository_dispatch event for an Agent review request. */
export const REVIEW_DISPATCH_TYPE = 'agent-review'

/**
 * Return the durable comment marker for one exact reviewed head.
 * @param {string} head
 * @returns {string}
 */
export function reviewMarker(head) {
  if (!/^[0-9a-f]{40}$/i.test(head)) throw new Error('Review markers require a full commit SHA')
  return `<!-- agent-review:${head.toLowerCase()} -->`
}
