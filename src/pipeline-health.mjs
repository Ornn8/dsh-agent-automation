import { appendFile, mkdtemp, readFile, rm } from 'node:fs/promises'
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
const replicaId = requiredEnv('AGENT_REPLICA_ID')
const readinessCanary = process.env.READINESS_CANARY?.toLowerCase() === 'true'
if (!config.repositories.includes(repository)) throw new Error(`${repository} is not in the runner allowlist`)
if (!/^[0-9a-f]{40}$/i.test(controllerSha)) throw new Error('CONTROLLER_SHA must be a full commit SHA')
if (!/^(?:target-[A-Za-z0-9_.-]+-(?:change|review)|organization-(?:change|review))(?:-r[2-8])?$/.test(replicaId)) {
  throw new Error('AGENT_REPLICA_ID must identify one exact product replica')
}
const heartbeat = JSON.parse(await readFile(join(config.operations.stateRoot, 'heartbeats', `${replicaId}.json`), 'utf8'))
const heartbeatAge = Date.now() - Date.parse(heartbeat.observedAtUtc)
if (heartbeat.instanceId !== replicaId || !Number.isFinite(heartbeatAge) || heartbeatAge < 0 || heartbeatAge > 20 * 60 * 1000) {
  throw new Error(`Replica ${replicaId} does not have a fresh exact heartbeat`)
}

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
  `- Replica: \`${replicaId}\` (fresh heartbeat)`,
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
