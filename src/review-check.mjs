import { parseJson, run } from './common.mjs'
import { capacityWaitStatusLine, parseCapacityWaitStatus } from './capacity-wait-projection.mjs'
import { REVIEW_CHECK_NAME } from './review-authority.mjs'

export { REVIEW_CHECK_NAME }
const GITHUB_ACTIONS_APP_ID = 15368
const REVIEW_IDENTITY_PREFIX = 'agent-review-v3'
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const FULL_HASH = /^[0-9a-f]{64}$/
const ACTIONS_RUN_URL = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/actions\/runs\/(\d+)(?:\/|$)/

function checkArguments(method, repository, checkId, fields) {
  const path = checkId === undefined
    ? `repos/${repository}/check-runs`
    : `repos/${repository}/check-runs/${checkId}`
  return ['api', '--method', method, path, ...fields.flatMap(([key, value]) => ['-f', `${key}=${value}`])]
}

function isRepositoryRunUrl(value, repository) {
  try {
    const url = new URL(value)
    const prefix = `/${repository}/`
    return url.origin === 'https://github.com'
      && url.pathname.startsWith(prefix)
      && (/^actions\/runs\/\d+(?:\/.*)?$/.test(url.pathname.slice(prefix.length))
        || /^runs\/\d+(?:\/.*)?$/.test(url.pathname.slice(prefix.length)))
  } catch {
    return false
  }
}

/** Return trusted GitHub Actions review CheckRun ids for one exact head. */
export function trustedReviewCheckIds(response, { repository, head }) {
  if (!Array.isArray(response?.check_runs)) throw new Error('Invalid review CheckRun response')
  if (response.total_count > response.check_runs.length) {
    throw new Error('Review CheckRun snapshot is incomplete')
  }
  return new Set(response.check_runs
    .filter(check => check?.name === REVIEW_CHECK_NAME
      && check.head_sha === head
      && check.app?.id === GITHUB_ACTIONS_APP_ID
      && isRepositoryRunUrl(check.details_url, repository)
      && Number.isSafeInteger(check.id)
      && check.id > 0)
    .map(check => check.id))
}

/** Return the newest controller-owned neutral capacity-deferred CheckRun for one exact head. */
export function trustedDeferredReviewCheckId(response, { repository, head, identity }) {
  if (!Array.isArray(response?.check_runs)) throw new Error('Invalid review CheckRun response')
  if (response.total_count > response.check_runs.length) {
    throw new Error('Review CheckRun snapshot is incomplete')
  }
  if (!Number.isSafeInteger(identity?.runId) || identity.runId < 1
    || !Number.isSafeInteger(identity?.runAttempt) || identity.runAttempt < 1) return null
  return response.check_runs
    .filter(check => check?.name === REVIEW_CHECK_NAME
      && check.head_sha === head
      && check.status === 'completed'
      && check.conclusion === 'neutral'
      && check.output?.title === 'Agent review neutral'
      && check.app?.id === GITHUB_ACTIONS_APP_ID
      && Number.isSafeInteger(check.id)
      && check.id > 0
      && isRepositoryRunUrl(check.details_url, repository)
      && (() => {
        const parsed = parseReviewCheckIdentity(check)
        return parsed?.workflowId === identity?.workflowId
          && parsed?.stageId === identity?.stageId
          && parsed?.definitionHash === identity?.definitionHash
          && parsed?.runId === identity.runId
          && parsed?.runAttempt === identity.runAttempt
      })())
    .map(check => check.id)
    .sort((left, right) => right - left)[0] ?? null
}

/** Return the newest exact-head capacity projection after the caller proves its Actions provenance. */
export function trustedDeferredReviewProjection(response, { repository, head, isTrustedReviewCheck } = {}) {
  if (!Array.isArray(response?.check_runs)) throw new Error('Invalid review CheckRun response')
  if (response.total_count > response.check_runs.length) {
    throw new Error('Review CheckRun snapshot is incomplete')
  }
  const trusted = check => {
    try {
      return typeof isTrustedReviewCheck === 'function' && isTrustedReviewCheck(check) === true
    } catch {
      return false
    }
  }
  const check = response.check_runs
    .filter(check => check?.name === REVIEW_CHECK_NAME
      && check.head_sha === head
      && check.status === 'completed'
      && check.conclusion === 'neutral'
      && check.output?.title === 'Agent review neutral'
      && check.app?.id === GITHUB_ACTIONS_APP_ID
      && Number.isSafeInteger(check.id)
      && check.id > 0
      && isRepositoryRunUrl(check.details_url, repository)
      && parseReviewCheckIdentity(check)
      && trusted(check))
    .sort((left, right) => right.id - left.id)
    [0]
  if (!check) return null
  try {
    return parseCapacityWaitStatus(check.output?.summary)
  } catch {
    return null
  }
}

/** Create one completed neutral exact-head CheckRun for a capacity-deferred review. */
export async function startDeferredReviewCheck({
  ghExecutable, repository, head, runUrl, runAttempt, identity, summary, capacityProjection, env, execute = run,
}) {
  const match = ACTIONS_RUN_URL.exec(runUrl)
  const runId = Number.parseInt(match?.[2] || '', 10)
  if (!match || match[1] !== repository || !Number.isSafeInteger(runId) || runId < 1) {
    throw new Error('Agent review run URL does not identify the target repository Actions run')
  }
  const outputSummary = capacityProjection
    ? `${summary}\n${capacityWaitStatusLine(capacityProjection)}`
    : summary
  const result = await execute(ghExecutable, checkArguments('POST', repository, undefined, [
    ['name', REVIEW_CHECK_NAME], ['head_sha', head], ['status', 'completed'], ['conclusion', 'neutral'], ['details_url', runUrl],
    ['external_id', reviewCheckIdentity({ ...identity, runId, runAttempt })],
    ['output[title]', 'Agent review neutral'], ['output[summary]', outputSummary],
  ]), { env })
  const check = parseJson(result.stdout, 'created deferred Agent review CheckRun')
  if (!Number.isSafeInteger(check?.id) || check.id < 1) throw new Error('GitHub did not return a deferred Agent review CheckRun id')
  return check.id
}

/** Report whether a new trusted review CheckRun appeared after a repair began. */
export function hasNewReviewCheck(before, after) {
  return [...after].some(checkId => !before.has(checkId))
}

/** Encode the trusted Profile workflow and exact Actions run attempt reviewed by one CheckRun. */
export function reviewCheckIdentity({ workflowId, stageId, definitionHash, runId, runAttempt }) {
  if (![workflowId, stageId].every(value => IDENTIFIER.test(value || ''))
    || !FULL_HASH.test(definitionHash || '')
    || !Number.isSafeInteger(runId)
    || runId < 1
    || !Number.isSafeInteger(runAttempt)
    || runAttempt < 1) {
    throw new Error('Agent review CheckRun identity is incomplete')
  }
  return `${REVIEW_IDENTITY_PREFIX}:${workflowId}:${stageId}:${definitionHash}:${runId}:${runAttempt}`
}

/** Parse the Profile workflow and exact Actions run-attempt identity from a controller-created CheckRun. */
export function parseReviewCheckIdentity(checkRun) {
  const parts = String(checkRun?.external_id || '').split(':')
  if (parts.length !== 6 || parts[0] !== REVIEW_IDENTITY_PREFIX) return null
  const [, workflowId, stageId, definitionHash, runIdText, runAttemptText] = parts
  const runId = Number.parseInt(runIdText, 10)
  const runAttempt = Number.parseInt(runAttemptText, 10)
  if (![workflowId, stageId].every(value => IDENTIFIER.test(value))
    || !FULL_HASH.test(definitionHash)
    || !/^[1-9][0-9]*$/.test(runIdText)
    || !/^[1-9][0-9]*$/.test(runAttemptText)
    || !Number.isSafeInteger(runId)
    || !Number.isSafeInteger(runAttempt)) return null
  return { workflowId, stageId, definitionHash, runId, runAttempt }
}

/** Create the GitHub Actions-owned review CheckRun on the exact pull request head. */
export async function startReviewCheck({ ghExecutable, repository, head, runUrl, runAttempt, identity, env, execute = run }) {
  const match = ACTIONS_RUN_URL.exec(runUrl)
  const runId = Number.parseInt(match?.[2] || '', 10)
  if (!match || match[1] !== repository || !Number.isSafeInteger(runId) || runId < 1) {
    throw new Error('Agent review run URL does not identify the target repository Actions run')
  }
  const result = await execute(ghExecutable, checkArguments('POST', repository, undefined, [
    ['name', REVIEW_CHECK_NAME], ['head_sha', head], ['status', 'in_progress'], ['details_url', runUrl], ['external_id', reviewCheckIdentity({ ...identity, runId, runAttempt })],
    ['output[title]', 'Agent review in progress'], ['output[summary]', 'Reviewing this exact pull request head.'],
  ]), { env })
  const check = parseJson(result.stdout, 'created Agent review CheckRun')
  if (!Number.isSafeInteger(check?.id) || check.id < 1) throw new Error('GitHub did not return a review CheckRun id')
  return check.id
}

/** Complete one controller-created exact-head review CheckRun. */
export async function completeReviewCheck({ ghExecutable, repository, checkId, runUrl, conclusion, summary, env, execute = run }) {
  if (!Number.isSafeInteger(checkId) || checkId < 1) throw new Error('Invalid review CheckRun id')
  if (!['success', 'failure'].includes(conclusion)) throw new Error(`Invalid review CheckRun conclusion: ${conclusion}`)
  await execute(ghExecutable, checkArguments('PATCH', repository, checkId, [
    ['status', 'completed'], ['conclusion', conclusion], ['details_url', runUrl],
    ['output[title]', `Agent review ${conclusion}`], ['output[summary]', summary],
  ]), { env })
}

/** Create a terminal exact-head CheckRun when review setup failed before one could start. */
export async function failReviewCheck({ ghExecutable, repository, head, runUrl, summary, env, execute = run }) {
  await execute(ghExecutable, checkArguments('POST', repository, undefined, [
    ['name', REVIEW_CHECK_NAME], ['head_sha', head], ['status', 'completed'], ['conclusion', 'failure'], ['details_url', runUrl], ['external_id', runUrl],
    ['output[title]', 'Agent review failure'], ['output[summary]', summary],
  ]), { env })
}
