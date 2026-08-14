import { actionsCredentialEnvironment, loadConfig, parseJson, requiredEnv, run } from './common.mjs'
import { hasExactReviewVerdict } from './review-protocol.mjs'

const repository = requiredEnv('TARGET_REPOSITORY')
const pullRequestNumber = Number.parseInt(requiredEnv('PR_NUMBER'), 10)
const head = requiredEnv('HEAD_SHA')
const config = await loadConfig()
const githubEnvironment = actionsCredentialEnvironment()
if (!config.repositories.includes(repository)) throw new Error(`${repository} is not in the runner allowlist`)
if (!Number.isSafeInteger(pullRequestNumber) || pullRequestNumber < 1) throw new Error('Invalid PR_NUMBER')

const commentsResult = await run(config.ghExecutable, [
  'api', `repos/${repository}/issues/${pullRequestNumber}/comments`, '--paginate',
], { env: githubEnvironment })
const comments = parseJson(commentsResult.stdout, 'pull request comments')
if (hasExactReviewVerdict(comments, head)) {
  process.stdout.write(`The exact head ${head} already has a Codex verdict; it is not an automation failure.\n`)
  process.exit(0)
}

await run(config.ghExecutable, [
  'api', '--method', 'POST', `repos/${repository}/statuses/${head}`,
  '-f', 'state=failure',
  '-f', 'context=codex/review',
  '-f', 'description=Codex review did not produce a passing verdict',
  '-f', `target_url=${requiredEnv('RUN_URL')}`,
], { env: githubEnvironment })

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
