import { appendFile } from 'node:fs/promises'
import {
  hostCredentialEnvironment,
  loadConfig,
  requiredEnv,
  resolveRepositoryWorker,
  run,
} from './common.mjs'
import { createAgentAdapters } from './agent-adapters.mjs'
import { checkAgentWorker } from './agent-worker.mjs'

const repository = requiredEnv('TARGET_REPOSITORY')
const controllerSha = requiredEnv('CONTROLLER_SHA')
const config = await loadConfig()
const workerId = resolveRepositoryWorker(config, repository, requiredEnv('AGENT_ROLE'))
if (!config.repositories.includes(repository)) throw new Error(`${repository} is not in the runner allowlist`)
if (!/^[0-9a-f]{40}$/i.test(controllerSha)) throw new Error('CONTROLLER_SHA must be a full commit SHA')

const worker = await checkAgentWorker({
  config,
  workerId,
  adapters: createAgentAdapters(),
})
await run(config.ghExecutable, ['repo', 'view', repository, '--json', 'nameWithOwner'], {
  env: hostCredentialEnvironment(),
})

const lines = [
  '# Agent worker health',
  '',
  `- Repository: \`${repository}\``,
  `- Controller: \`${controllerSha}\``,
  `- Worker: \`${worker.workerId}\``,
  `- Adapter: ${worker.detail}`,
  '- GitHub host credential: repository access verified',
  '- Model calls: none',
  '',
]
const report = lines.join('\n')
process.stdout.write(report)
if (process.env.GITHUB_STEP_SUMMARY) {
  await appendFile(process.env.GITHUB_STEP_SUMMARY, report, 'utf8')
}
