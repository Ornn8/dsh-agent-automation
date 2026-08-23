import { setTimeout as delay } from 'node:timers/promises'

const SHA = /^[0-9a-f]{40}$/
const PROFILE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const REVIEW_TITLE = /^Agent PR Review #(\d+) ([0-9a-f]{40})\.\.([0-9a-f]{40}) profile:([A-Za-z0-9][A-Za-z0-9._-]{0,63})(?: request:[A-Za-z0-9._-]{1,100})?$/
const TARGET_REVIEW_WORKFLOW_PATH = '.github/workflows/agent-pr-review.yml'
const SOURCE_SETTLE_ATTEMPTS = 15
const SOURCE_SETTLE_DELAY_MS = 1_000

/** Verify the immutable Profile and exact pair named by a target review workflow run. The target path is fixed; the visible run name is dynamic. @param {unknown} value @param {{ repository: string, controllerRepository: string, controllerSha: string, workflowPath: string, number?: number, base?: string, head?: string }} expected @returns {{ number: number, base: string, head: string, profileId: string }} */
export function trustedReviewRunProfile(value, expected) {
  const source = /** @type {Record<string, unknown>} */ (value)
  const title = REVIEW_TITLE.exec(String(source?.display_title || ''))
  const expectedReference = `${expected.controllerRepository}/${expected.workflowPath}@${expected.controllerSha}`
  const references = Array.isArray(source?.referenced_workflows) ? source.referenced_workflows : []
  const trustedReference = references.some(reference => reference?.path === expectedReference
    && reference?.sha === expected.controllerSha)
  const number = Number.parseInt(title?.[1] || '', 10)
  if (source?.repository?.full_name !== expected.repository
    || source?.path !== TARGET_REVIEW_WORKFLOW_PATH
    || !title
    || !trustedReference
    || (expected.number !== undefined && number !== expected.number)
    || (expected.base !== undefined && title[2] !== expected.base)
    || (expected.head !== undefined && title[3] !== expected.head)) {
    throw new Error('Review workflow does not identify one trusted exact-pair Profile')
  }
  return { number, base: title[2], head: title[3], profileId: title[4] }
}

/** Wait briefly for a direct-wake source run to finish before reading its terminal evidence. @param {() => Promise<unknown>} readSource @param {{ runId: number, runAttempt: number, repository: string, controllerRepository: string, controllerSha: string, workflowPath: string, profileId?: string }} expected @param {{ wait?: (milliseconds: number) => Promise<unknown> }} [options] @returns {Promise<{ number: number, base: string, head: string, profileId: string }>} */
export async function terminalReviewSourceAfterSettling(readSource, expected, { wait = delay } = {}) {
  let source = await readSource()
  for (let attempt = 0; attempt < SOURCE_SETTLE_ATTEMPTS && source?.status !== 'completed'; attempt += 1) {
    await wait(SOURCE_SETTLE_DELAY_MS)
    source = await readSource()
  }
  return terminalReviewSource(source, expected)
}

/**
 * Verify a target review workflow as the source of one advancement wake. A direct
 * dispatch may observe the source while its final workflow steps are still closing;
 * callers settle the source attempt before this terminal check, and the exact
 * completed CheckRun is validated by the advancement snapshot afterwards.
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
