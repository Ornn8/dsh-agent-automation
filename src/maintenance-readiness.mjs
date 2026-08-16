import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  loadConfig,
  maintenanceCredentialEnvironment,
  parseJson,
  requiredEnv,
  resolveRoleWorkers,
  run,
} from './common.mjs'
import { createAgentAdapters } from './agent-adapters.mjs'
import { checkAgentWorker, runAgentWorker } from './agent-worker.mjs'
import { AGENT_READINESS_SKILL } from './agent-work-result.mjs'

const controllerRepository = requiredEnv('CONTROLLER_REPOSITORY')
const replicaId = requiredEnv('AGENT_REPLICA_ID')
const readinessCanary = process.env.READINESS_CANARY?.toLowerCase() === 'true'
const config = await loadConfig()
const maintenanceWorkers = resolveRoleWorkers(config, 'maintenance')
const adapters = createAgentAdapters()

if (config.operations.controller.repository !== controllerRepository
  || !/^controller-[A-Za-z0-9_.-]+-maintenance$/.test(replicaId)) {
  throw new Error('Maintenance readiness identity does not match local Controller configuration')
}
const heartbeat = JSON.parse(await readFile(join(config.operations.stateRoot, 'heartbeats', `${replicaId}.json`), 'utf8'))
const heartbeatAge = Date.now() - Date.parse(heartbeat.observedAtUtc)
if (heartbeat.instanceId !== replicaId || !Number.isFinite(heartbeatAge)
  || heartbeatAge < 0 || heartbeatAge > 20 * 60 * 1000) {
  throw new Error('Maintenance replica does not have a fresh exact heartbeat')
}

const available = []
for (const workerId of maintenanceWorkers) {
  const worker = config.workers[workerId]
  try {
    await checkAgentWorker({ config, workerId, adapters })
    const environment = maintenanceCredentialEnvironment(worker)
    const identity = await run(config.ghExecutable, ['api', 'user'], { env: environment })
    if (parseJson(identity.stdout, `${workerId} GitHub identity`).login !== worker.githubLogin) continue
    await run(config.ghExecutable, ['repo', 'view', controllerRepository, '--json', 'nameWithOwner'], { env: environment })
    available.push(workerId)
  } catch {
    // An unavailable declared Worker remains visible in the final bounded result.
  }
}
if (available.length === 0) throw new Error('No declared maintenance Worker has a usable CLI and dedicated Controller credential')

if (readinessCanary) {
  const directory = await mkdtemp(join(tmpdir(), 'agent-maintenance-readiness-'))
  try {
    const receipt = await runAgentWorker({
      config,
      workerId: available[0],
      invocation: {
        taskId: `maintenance-readiness-${Date.now()}`,
        cwd: directory,
        title: '[Maintenance] 每日就绪检查',
        prompt: `/${AGENT_READINESS_SKILL} Verify this configured maintenance Agent and provider. Do not inspect a repository or access GitHub.`,
        requiredSkill: AGENT_READINESS_SKILL,
        timeoutMs: 10 * 60 * 1000,
      },
      adapters,
    })
    if (receipt.outcome !== 'completed') throw new Error(`Maintenance readiness canary ended with ${receipt.outcome}`)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

process.stdout.write(`Maintenance replica ${replicaId} is ready; ${available.length} declared Worker(s) are available.\n`)
