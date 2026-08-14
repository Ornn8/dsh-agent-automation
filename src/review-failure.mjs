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
const checkId = Number.parseInt(process.env.REVIEW_CHECK_ID || '', 10)
if (Number.isSafeInteger(checkId) && checkId > 0) {
  await completeReviewCheck({
    ghExecutable: config.ghExecutable, repository, checkId, runUrl, conclusion: 'failure',
    summary: 'Codex review infrastructure did not return a verdict.', env: githubEnvironment,
  })
} else {
  await failReviewCheck({
    ghExecutable: config.ghExecutable, repository, head, runUrl,
    summary: 'Codex review infrastructure did not return a verdict.', env: githubEnvironment,
  })
}

await run(config.ghExecutable, [
  'pr', 'merge', String(pullRequestNumber), '--repo', repository, '--disable-auto',
], { env: githubEnvironment }).catch(() => undefined)
await run(config.ghExecutable, [
  'label', 'create', 'automation/review-failed', '--repo', repository,
  '--description', 'Codex review automation failed before a verdict', '--color', 'D93F0B',
], { env: githubEnvironment }).catch(() => undefined)
await run(config.ghExecutable, [
  'pr', 'edit', String(pullRequestNumber), '--repo', repository,
  '--add-label', 'automation/review-failed',
], { env: githubEnvironment }).catch(() => undefined)
