import { parseJson, run } from './common.mjs'

export const REVIEW_CHECK_NAME = 'codex/review'

function checkArguments(method, repository, checkId, fields) {
  const path = checkId === undefined
    ? `repos/${repository}/check-runs`
    : `repos/${repository}/check-runs/${checkId}`
  return ['api', '--method', method, path, ...fields.flatMap(([key, value]) => ['-f', `${key}=${value}`])]
}

/** Create the GitHub Actions-owned review CheckRun on the exact pull request head. */
export async function startReviewCheck({ ghExecutable, repository, head, runUrl, env, execute = run }) {
  const result = await execute(ghExecutable, checkArguments('POST', repository, undefined, [
    ['name', REVIEW_CHECK_NAME], ['head_sha', head], ['status', 'in_progress'], ['details_url', runUrl],
    ['output[title]', 'Codex review in progress'], ['output[summary]', 'Reviewing this exact pull request head.'],
  ]), { env })
  const check = parseJson(result.stdout, 'created Codex review CheckRun')
  if (!Number.isSafeInteger(check?.id) || check.id < 1) throw new Error('GitHub did not return a review CheckRun id')
  return check.id
}

/** Complete one controller-created exact-head review CheckRun. */
export async function completeReviewCheck({ ghExecutable, repository, checkId, runUrl, conclusion, summary, env, execute = run }) {
  if (!Number.isSafeInteger(checkId) || checkId < 1) throw new Error('Invalid review CheckRun id')
  if (!['success', 'failure'].includes(conclusion)) throw new Error(`Invalid review CheckRun conclusion: ${conclusion}`)
  await execute(ghExecutable, checkArguments('PATCH', repository, checkId, [
    ['status', 'completed'], ['conclusion', conclusion], ['details_url', runUrl],
    ['output[title]', `Codex review ${conclusion}`], ['output[summary]', summary],
  ]), { env })
}

/** Create a terminal exact-head CheckRun when review setup failed before one could start. */
export async function failReviewCheck({ ghExecutable, repository, head, runUrl, summary, env, execute = run }) {
  await execute(ghExecutable, checkArguments('POST', repository, undefined, [
    ['name', REVIEW_CHECK_NAME], ['head_sha', head], ['status', 'completed'], ['conclusion', 'failure'], ['details_url', runUrl],
    ['output[title]', 'Codex review failure'], ['output[summary]', summary],
  ]), { env })
}
