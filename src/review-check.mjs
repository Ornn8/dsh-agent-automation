import { parseJson, run } from './common.mjs'
import { REVIEW_CHECK_NAME } from './review-authority.mjs'

export { REVIEW_CHECK_NAME }
const GITHUB_ACTIONS_APP_ID = 15368

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

/** Report whether a new trusted review CheckRun appeared after a repair began. */
export function hasNewReviewCheck(before, after) {
  return [...after].some(checkId => !before.has(checkId))
}

/** Create the GitHub Actions-owned review CheckRun on the exact pull request head. */
export async function startReviewCheck({ ghExecutable, repository, head, runUrl, env, execute = run }) {
  const result = await execute(ghExecutable, checkArguments('POST', repository, undefined, [
    ['name', REVIEW_CHECK_NAME], ['head_sha', head], ['status', 'in_progress'], ['details_url', runUrl], ['external_id', runUrl],
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
