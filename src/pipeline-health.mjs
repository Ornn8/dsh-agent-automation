import { appendFile, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  hostCredentialEnvironment,
  loadConfig,
  requiredEnv,
  resolveRepositoryWorker,
  run,
} from './common.mjs'
import { createAgentAdapters } from './agent-adapters.mjs'
import { checkAgentWorker, runAgentWorker } from './agent-worker.mjs'
import { AGENT_READINESS_SKILL } from './agent-work-result.mjs'

const repository = requiredEnv('TARGET_REPOSITORY')
const controllerSha = requiredEnv('CONTROLLER_SHA')
const config = await loadConfig()
const workerId = resolveRepositoryWorker(config, repository, requiredEnv('AGENT_ROLE'))
const readinessCanary = process.env.READINESS_CANARY?.toLowerCase() === 'true'
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

let canaryDetail = 'not requested'
if (readinessCanary) {
  const canaryDirectory = await mkdtemp(join(tmpdir(), 'agent-readiness-'))
  try {
    const receipt = await runAgentWorker({
      config,
      workerId,
      invocation: {
        taskId: `readiness-${repository.replace('/', '-')}-${Date.now()}`,
        cwd: canaryDirectory,
        title: `[Agent] 每日就绪检查 ${repository}`,
        prompt: `/${AGENT_READINESS_SKILL} Verify this configured Agent and provider. Do not inspect a repository or access GitHub.`,
        requiredSkill: AGENT_READINESS_SKILL,
        timeoutMs: 10 * 60 * 1000,
      },
      adapters: createAgentAdapters(),
    })
    if (receipt.outcome !== 'completed') throw new Error(`Readiness canary ended with ${receipt.outcome}`)
    canaryDetail = `completed in session ${receipt.sessionId}`
  } finally {
    await rm(canaryDirectory, { recursive: true, force: true })
  }
}

const lines = [
  '# Agent worker health',
  '',
  `- Repository: \`${repository}\``,
  `- Controller: \`${controllerSha}\``,
  `- Worker: \`${worker.workerId}\``,
  `- Adapter: ${worker.detail}`,
  '- GitHub host credential: repository access verified',
  `- Provider readiness canary: ${canaryDetail}`,
  '',
]
const report = lines.join('\n')
process.stdout.write(report)
if (process.env.GITHUB_STEP_SUMMARY) {
  await appendFile(process.env.GITHUB_STEP_SUMMARY, report, 'utf8')
}
