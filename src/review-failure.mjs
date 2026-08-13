import { hostCredentialEnvironment, loadConfig, requiredEnv, run } from './common.mjs'

const repository = requiredEnv('TARGET_REPOSITORY')
const head = requiredEnv('HEAD_SHA')
const config = await loadConfig()
if (!config.repositories.includes(repository)) throw new Error(`${repository} is not in the runner allowlist`)

await run(config.ghExecutable, [
  'api', '--method', 'POST', `repos/${repository}/statuses/${head}`,
  '-f', 'state=failure',
  '-f', 'context=codex/review',
  '-f', 'description=Codex review did not produce a passing verdict',
  '-f', `target_url=${requiredEnv('RUN_URL')}`,
], { env: hostCredentialEnvironment() })

