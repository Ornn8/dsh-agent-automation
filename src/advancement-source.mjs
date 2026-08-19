const SHA = /^[0-9a-f]{40}$/
const PROFILE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const REVIEW_TITLE = /^Agent PR Review #(\d+) ([0-9a-f]{40})\.\.([0-9a-f]{40}) profile:([A-Za-z0-9][A-Za-z0-9._-]{0,63})(?: request:[A-Za-z0-9._-]{1,100})?$/

/** Verify the immutable profile and exact pair named by a review workflow run. @param {unknown} value @param {{ repository: string, controllerRepository: string, controllerSha: string, workflowPath: string, number?: number, base?: string, head?: string }} expected @returns {{ number: number, base: string, head: string, profileId: string }} */
export function trustedReviewRunProfile(value, expected) {
  const source = /** @type {Record<string, unknown>} */ (value)
  const title = REVIEW_TITLE.exec(String(source?.display_title || ''))
  const expectedReference = `${expected.controllerRepository}/${expected.workflowPath}@${expected.controllerSha}`
  const references = Array.isArray(source?.referenced_workflows) ? source.referenced_workflows : []
  const trustedReference = references.some(reference => reference?.path === expectedReference
    && reference?.sha === expected.controllerSha)
  const number = Number.parseInt(title?.[1] || '', 10)
  if (source?.repository?.full_name !== expected.repository
    || source?.name !== 'Agent PR Review'
    || !title
    || !trustedReference
    || (expected.number !== undefined && number !== expected.number)
    || (expected.base !== undefined && title[2] !== expected.base)
    || (expected.head !== undefined && title[3] !== expected.head)) {
    throw new Error('Review workflow does not identify one trusted exact-pair Profile')
  }
  return { number, base: title[2], head: title[3], profileId: title[4] }
}

/**
 * Verify a completed target review workflow as the source of one advancement wake.
 * The display title binds the exact PR pair while referenced workflow provenance
 * pins the immutable controller revision that produced the review CheckRun.
 * @param {unknown} value
 * @param {{ runId: number, runAttempt: number, repository: string, controllerRepository: string, controllerSha: string, workflowPath: string, profileId?: string }} expected
 * @returns {{ number: number, base: string, head: string, profileId: string }}
 */
export function terminalReviewSource(value, expected) {
  const source = /** @type {Record<string, unknown>} */ (value)
  const title = REVIEW_TITLE.exec(String(source?.display_title || ''))
  let profile = null
  try {
    profile = title && trustedReviewRunProfile(source, expected)
  } catch {
    throw new Error('Advancement source review workflow is not one completed trusted exact-pair invocation')
  }
  if (source?.id !== expected.runId
    || source?.run_attempt !== expected.runAttempt
    || source?.repository?.full_name !== expected.repository
    || source?.name !== 'Agent PR Review'
    || source?.status !== 'completed'
    || !title
    || !profile
    || (expected.profileId !== undefined && profile.profileId !== expected.profileId)) {
    throw new Error('Advancement source review workflow is not one completed trusted exact-pair invocation')
  }
  const number = Number.parseInt(title[1], 10)
  if (!Number.isSafeInteger(number) || number < 1 || !SHA.test(title[2]) || !SHA.test(title[3])) {
    throw new Error('Advancement source review workflow title is invalid')
  }
  if (!PROFILE_ID.test(profile.profileId)) throw new Error('Advancement source review Profile is invalid')
  return profile
}
