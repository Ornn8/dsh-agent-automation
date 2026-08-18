import { actionsCredentialEnvironment, loadConfig, requiredEnv, run } from './common.mjs'
import { completeReviewCheck, failReviewCheck } from './review-check.mjs'

const repository = requiredEnv('TARGET_REPOSITORY')
const pullRequestNumber = Number.parseInt(requiredEnv('PR_NUMBER'), 10)
const head = requiredEnv('HEAD_SHA')
const config = await loadConfig()
const githubEnvironment = actionsCredentialEnvironment()
if (!config.repositories.includes(repository)) throw new Error(`${repository} is not in the runner allowlist`)
if (!Number.isSafeInteger(pullRequestNumber) || pullRequestNumber < 1) throw new Error('Invalid PR_NUMBER')

const runUrl = requiredEnv('RUN_URL')
const failureClass = process.env.REVIEW_FAILURE_CLASS?.trim() || 'host'
const failureCode = process.env.REVIEW_FAILURE_CODE?.trim() || 'review-infrastructure-failure'
if (!['transport', 'auth-quota', 'protocol', 'task', 'host', 'permissions'].includes(failureClass)
  || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(failureCode)) {
  throw new Error('Review failure identity is invalid')
}
const summary = `Agent review infrastructure did not return a verdict. Failure class: ${failureClass}. Error code: ${failureCode}.`
const checkId = Number.parseInt(process.env.REVIEW_CHECK_ID || '', 10)
if (Number.isSafeInteger(checkId) && checkId > 0) {
  await completeReviewCheck({
    ghExecutable: config.ghExecutable, repository, checkId, runUrl, conclusion: 'failure',
    summary, env: githubEnvironment,
  })
} else {
  await failReviewCheck({
    ghExecutable: config.ghExecutable, repository, head, runUrl,
    summary, env: githubEnvironment,
  })
}

await run(config.ghExecutable, [
  'pr', 'merge', String(pullRequestNumber), '--repo', repository, '--disable-auto',
], { env: githubEnvironment }).catch(() => undefined)
await run(config.ghExecutable, [
  'label', 'create', 'automation/review-failed', '--repo', repository,
  '--description', 'Agent review automation failed before a verdict', '--color', 'D93F0B',
], { env: githubEnvironment }).catch(() => undefined)
await run(config.ghExecutable, [
  'pr', 'edit', String(pullRequestNumber), '--repo', repository,
  '--add-label', 'automation/review-failed',
], { env: githubEnvironment }).catch(() => undefined)
