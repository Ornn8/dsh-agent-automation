import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import {
  hostCredentialEnvironment,
  loadConfig,
  parseJson,
  requiredEnv,
  resolveRoleWorkers,
  run,
  verifyGithubIdentity,
} from './common.mjs'
import { resolveWorkerCandidates } from './machine-config.mjs'
import { createAgentAdapters } from './agent-adapters.mjs'
import { runAgentWorker } from './agent-worker.mjs'
import { AGENT_MAINTENANCE_SKILL, AGENT_REVIEW_SKILL, agentWorkPrompt } from './agent-work-result.mjs'
import { attestedFaultRecordBody, trustedFaultRecords } from './fault-attestation.mjs'
import {
  beginFaultEpoch,
  attachRootRequests,
  createFaultRecord,
  nextFaultAction,
  openFaultCircuit,
  recordFaultAttempt,
} from './fault-record.mjs'
import { parseFaultProjection } from './fault-projection.mjs'
import { trustedFaultProjectionRun } from './fault-observation.mjs'
import { observeFaultHealth, parseFaultHealthState } from './fault-health.mjs'
import { parseMaintenanceProfile } from './maintenance-profile.mjs'
import { assessMaintenanceCi, MAINTENANCE_CI_WORKFLOW_PATH } from './maintenance-ci.mjs'
import { assessMaintenancePromotion, confirmMaintenancePromotionHead } from './maintenance-promotion.mjs'
import { parseReviewMessage } from './review-protocol.mjs'
import { validateReviewFindings } from './review-evidence.mjs'

const controllerRepository = requiredEnv('CONTROLLER_REPOSITORY')
const controllerSha = requiredEnv('CONTROLLER_SHA').toLowerCase()
const controllerCheckout = resolve(requiredEnv('CONTROLLER_CHECKOUT'))
const runId = Number.parseInt(requiredEnv('GITHUB_RUN_ID'), 10)
const replicaId = requiredEnv('AGENT_REPLICA_ID')
const configPath = resolve(requiredEnv('DSH_AGENT_CONFIG'))
const environment = hostCredentialEnvironment()
const config = await loadConfig()
const profile = parseMaintenanceProfile(JSON.parse(await readFile(
  join(controllerCheckout, '.github', 'agent-automation', 'profiles', 'controller-maintenance.json'), 'utf8',
)))
const maintenanceCiWorkflowFile = MAINTENANCE_CI_WORKFLOW_PATH.slice(MAINTENANCE_CI_WORKFLOW_PATH.lastIndexOf('/') + 1)
const maintenanceWorkers = resolveRoleWorkers(config, 'maintenance')
const [reviewWorker] = resolveWorkerCandidates({ config, role: 'review', routeDecision: { route: 'default' } })
const adapters = createAgentAdapters()

if (config.operations.controller.repository !== controllerRepository) throw new Error('Maintenance workflow repository differs from local Controller configuration')
if (!/^[0-9a-f]{40}$/.test(controllerSha) || !Number.isSafeInteger(runId) || runId < 1) throw new Error('Maintenance workflow identity is invalid')
if (!/^controller-[A-Za-z0-9_.-]+-maintenance$/.test(replicaId)) throw new Error('Maintenance workflow requires one exact replica identity')
const replicaHeartbeat = JSON.parse(await readFile(join(config.operations.stateRoot, 'heartbeats', `${replicaId}.json`), 'utf8'))
const replicaHeartbeatAge = Date.now() - Date.parse(replicaHeartbeat.observedAtUtc)
if (replicaHeartbeat.instanceId !== replicaId || !Number.isFinite(replicaHeartbeatAge)
  || replicaHeartbeatAge < 0 || replicaHeartbeatAge > 20 * 60 * 1000) {
  throw new Error('Maintenance replica does not have a fresh exact heartbeat')
}
await verifyGithubIdentity({ config })

async function ghJson(args, description) {
  const result = await run(config.ghExecutable, args, { env: environment })
  return parseJson(result.stdout, description)
}

async function pages(path, description, field) {
  const values = []
  for (let page = 1; page <= 4; page += 1) {
    const payload = await ghJson(['api', `${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`], description)
    const pageValues = field === undefined ? payload : payload?.[field]
    if (!Array.isArray(pageValues)) throw new Error(`${description} did not return a page array`)
    if (page === 4 && pageValues.length > 0) throw new Error(`${description} exceeded the bounded three-page snapshot`)
    values.push(...pageValues)
    if (pageValues.length < 100) break
  }
  return values
}

async function appendRecord(repository, issueNumber, record) {
  await run(config.ghExecutable, ['api', '--method', 'POST', `repos/${repository}/issues/${issueNumber}/comments`, '--input', '-'], {
    env: environment,
    input: JSON.stringify({ body: attestedFaultRecordBody(record, { repository: controllerRepository, controllerSha, runId }) }),
  })
}

async function verifyProjection(issue, projection) {
  const runValue = await ghJson(['api', `repos/${projection.repository}/actions/runs/${projection.projectionRunId}`], 'fault projection workflow run')
  return trustedFaultProjectionRun({
    issue, projection, run: runValue, trustedControllerRepository: controllerRepository,
  })
}

async function localStateVersion(projection, healthGeneration) {
  const manifest = JSON.parse(await readFile(join(config.operations.stateRoot, 'install-manifest.json'), 'utf8'))
  const runtimeSnapshotHash = manifest?.operationsRuntime?.id
  if (!/^[0-9a-f]{64}$/.test(runtimeSnapshotHash || '')) throw new Error('Installed runtime snapshot identity is unavailable')
  return {
    controllerSha,
    runtimeSnapshotHash,
    configurationHash: config.configurationHash,
    credentialGeneration: config.credentialGeneration,
    healthGeneration,
    failureSignature: projection.failureSignature,
  }
}

function componentArgs(projection, action, checkout = controllerCheckout) {
  const component = projection.component === 'review-worker' ? 'review'
    : projection.component === 'change-worker' ? 'change'
      : projection.component === 'maintenance-worker' ? 'maintenance'
        : projection.component === 'dsh-web-host' ? 'dsh-web' : null
  if (!component) throw new Error(`No deterministic component adapter for ${projection.component}`)
  return [
    '-NoProfile', '-File', join(checkout, 'scripts', 'control.ps1'),
    '-Configuration', configPath, '-Component', component,
    ...(['dsh-web', 'maintenance'].includes(component) ? [] : ['-Repository', projection.repository]),
    '-Action', action,
  ]
}

async function observeComponentHealth(projection) {
  let healthy = true
  try {
    await run('pwsh', componentArgs(projection, 'status'), { env: environment, timeoutMs: 10 * 60 * 1000 })
  } catch {
    healthy = false
  }
  const directory = join(config.operations.stateRoot, 'fault-health')
  const path = join(directory, `${projection.faultId}.json`)
  let prior
  try {
    prior = parseFaultHealthState(JSON.parse(await readFile(path, 'utf8')), projection.faultId)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw new Error(`Fault health state is invalid: ${error.message}`)
  }
  const next = observeFaultHealth(prior, { faultId: projection.faultId, healthy })
  await mkdir(directory, { recursive: true })
  const temporary = `${path}.${randomUUID()}.tmp`
  await writeFile(temporary, `${JSON.stringify(next)}\n`, { encoding: 'utf8', flag: 'wx' })
  await rename(temporary, path)
  return next.generation
}

async function executeDeterministic(action, projection) {
  if (action.target === 'restart-component') {
    await run('pwsh', componentArgs(projection, 'restart'), { env: environment, timeoutMs: 10 * 60 * 1000 })
  } else if (action.target === 'start-component') {
    await run('pwsh', componentArgs(projection, 'start'), { env: environment, timeoutMs: 10 * 60 * 1000 })
  } else if (action.target === 'reconcile-managed-state') {
    await run('pwsh', [
      '-NoProfile', '-File', join(controllerCheckout, 'scripts', 'install.ps1'),
      '-Configuration', configPath,
    ], { env: environment, timeoutMs: 30 * 60 * 1000 })
  } else {
    throw new Error(`Unknown deterministic recovery procedure ${action.target}`)
  }
  await run('pwsh', componentArgs(projection, 'status'), { env: environment, timeoutMs: 10 * 60 * 1000 })
}

async function cloneController(branch) {
  const directory = await mkdtemp(join(tmpdir(), 'agent-maintenance-'))
  await run(config.ghExecutable, ['repo', 'clone', controllerRepository, directory, '--', '--filter=blob:none'], { env: environment })
  const repository = await ghJson(['api', `repos/${controllerRepository}`], 'Controller repository')
  await run(config.gitExecutable, ['checkout', '-b', branch, `origin/${repository.default_branch}`], { cwd: directory, env: environment })
  const base = (await run(config.gitExecutable, ['rev-parse', 'HEAD'], { cwd: directory, env: environment })).stdout.trim()
  return { directory, base }
}

async function checkoutControllerAt(sha) {
  const directory = await mkdtemp(join(tmpdir(), 'agent-controller-release-'))
  await run(config.ghExecutable, ['repo', 'clone', controllerRepository, directory, '--', '--filter=blob:none'], { env: environment })
  await run(config.gitExecutable, ['fetch', 'origin', sha], { cwd: directory, env: environment })
  await run(config.gitExecutable, ['checkout', '--detach', sha], { cwd: directory, env: environment })
  const actual = (await run(config.gitExecutable, ['rev-parse', 'HEAD'], { cwd: directory, env: environment })).stdout.trim()
  if (actual !== sha) throw new Error('Published Controller checkout does not match the attested SHA')
  return directory
}

function pathPattern(pattern) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '.*')
  return new RegExp(`^${escaped}$`)
}

async function validateMaintenancePullRequest(record, pull) {
  if (pull.state !== 'open' || pull.head?.repo?.full_name !== controllerRepository
    || !String(pull.body || '').includes(record.faultId)
    || !String(pull.body || '').includes(`epoch ${record.epochs.at(-1).number}`)) {
    throw new Error('Maintenance pull request does not bind the root fault and current epoch')
  }
  const files = await pages(`repos/${controllerRepository}/pulls/${pull.number}/files`, 'maintenance pull request files')
  if (files.length < 1 || files.some(file => !profile.repair.allowedPaths.some(pattern => pathPattern(pattern).test(file.filename)))) {
    throw new Error('Maintenance pull request changes a path outside the Maintenance Profile')
  }
  return files
}

async function executeMaintenanceWorker(record, action, issueNumber) {
  const branch = `automation/fault-${record.faultId.slice(0, 12)}-e${record.epochs.at(-1).number}`
  const existingPulls = await ghJson([
    'pr', 'list', '--repo', controllerRepository, '--state', 'open', '--head', branch,
    '--json', 'number,headRefOid,baseRefOid', '--limit', '2',
  ], 'existing fault-bound maintenance pull request')
  if (existingPulls.length > 1) throw new Error('Root fault has more than one maintenance pull request')
  if (existingPulls.length === 1) return existingPulls[0]
  const intentDirectory = join(config.operations.stateRoot, 'maintenance-intents')
  const intentPath = join(intentDirectory, `${record.faultId}-e${record.epochs.at(-1).number}-${action.target}.json`)
  await mkdir(intentDirectory, { recursive: true })
  try {
    await writeFile(intentPath, `${JSON.stringify({
      version: 1,
      faultId: record.faultId,
      epoch: record.epochs.at(-1).number,
      workerId: action.target,
      taskId: `maintenance-${record.faultId}-e${record.epochs.at(-1).number}-${action.sequence}`,
    })}\n`, { encoding: 'utf8', flag: 'wx' })
  } catch (error) {
    if (error?.code === 'EEXIST') throw new Error('A prior maintenance attempt ended without a published pull request; refusing to invoke the Worker again')
    throw error
  }
  const checkout = await cloneController(branch)
  try {
    const request = {
      version: 1,
      faultId: record.faultId,
      epoch: record.epochs.at(-1).number,
      repository: controllerRepository,
      faultIssue: { repository: record.repository, number: issueNumber },
      baseSha: checkout.base,
      branch,
      allowedPaths: profile.repair.allowedPaths,
    }
    const receipt = await runAgentWorker({
      config,
      workerId: action.target,
      invocation: {
        taskId: `maintenance-${record.faultId}-e${request.epoch}-${action.sequence}`,
        cwd: checkout.directory,
        title: `[Maintenance] ${record.component} ${record.operation}`,
        prompt: agentWorkPrompt(AGENT_MAINTENANCE_SKILL, request),
        requiredSkill: AGENT_MAINTENANCE_SKILL,
        timeoutMs: 90 * 60 * 1000,
      },
      adapters,
    })
    if (receipt.outcome !== 'completed') throw new Error(`Maintenance Worker ended with ${receipt.outcome}: ${receipt.detail}`)
    const pulls = await ghJson([
      'pr', 'list', '--repo', controllerRepository, '--state', 'open', '--head', branch,
      '--json', 'number,headRefOid,baseRefOid', '--limit', '2',
    ], 'fault-bound maintenance pull request')
    if (pulls.length !== 1 || pulls[0].baseRefOid !== checkout.base) throw new Error('Maintenance Worker did not publish exactly one pull request from the supplied base')
    return pulls[0]
  } finally {
    await rm(checkout.directory, { recursive: true, force: true })
  }
}

async function reviewMaintenancePullRequest(record) {
  const pull = await ghJson(['api', `repos/${controllerRepository}/pulls/${record.repairPullRequest}`], 'maintenance pull request')
  await validateMaintenancePullRequest(record, pull)
  const checkout = await cloneController(`review-${record.faultId.slice(0, 12)}`)
  try {
    await run(config.gitExecutable, ['fetch', 'origin', pull.base.sha, pull.head.sha], { cwd: checkout.directory, env: environment })
    await run(config.gitExecutable, ['checkout', '--detach', pull.head.sha], { cwd: checkout.directory, env: environment })
    const receipt = await runAgentWorker({
      config,
      workerId: reviewWorker,
      invocation: {
        taskId: `review-${pull.base.sha}-${pull.head.sha}`,
        cwd: checkout.directory,
        title: `[Maintenance review] PR #${pull.number}`,
        prompt: `Review fault-bound Controller maintenance PR #${pull.number} at exact pair ${pull.base.sha}..${pull.head.sha}. Require every changed path to match: ${profile.repair.allowedPaths.join(', ')}.`,
        requiredSkill: AGENT_REVIEW_SKILL,
        timeoutMs: 60 * 60 * 1000,
      },
      adapters,
    })
    if (receipt.outcome !== 'completed') throw new Error(`Maintenance review ended with ${receipt.outcome}`)
    const review = parseReviewMessage(receipt.output)
    await validateReviewFindings(review, {
      gitExecutable: config.gitExecutable,
      reviewCheckout: checkout.directory,
      base: pull.base.sha,
      head: pull.head.sha,
      runCommand: run,
      environment,
    })
    return { review, pull }
  } finally {
    await rm(checkout.directory, { recursive: true, force: true })
  }
}

async function checkMaintenanceCi(record) {
  const pull = await ghJson(['api', `repos/${controllerRepository}/pulls/${record.repairPullRequest}`], 'maintenance pull request')
  const files = await validateMaintenancePullRequest(record, pull)
  const workflowRuns = await pages(
    `repos/${controllerRepository}/actions/workflows/${maintenanceCiWorkflowFile}/runs?event=pull_request&head_sha=${pull.head.sha}`,
    'maintenance CI workflow runs', 'workflow_runs',
  )
  const checks = await pages(`repos/${controllerRepository}/commits/${pull.head.sha}/check-runs`, 'maintenance CI checks', 'check_runs')
  const ci = assessMaintenanceCi({
    pull,
    files,
    workflowRuns,
    checkRuns: checks,
    repository: controllerRepository,
    workflowName: profile.checks.workflowNames[0],
    requiredCheckNames: profile.checks.requiredChecks,
  })
  if (ci.outcome === 'waiting') {
    const age = Date.now() - Date.parse(pull.created_at)
    return age > profile.checks.waitMinutes * 60 * 1000
      ? { outcome: 'failed', pull, detail: `trusted Controller CI evidence missing after ${profile.checks.waitMinutes} minutes` }
      : { outcome: 'waiting', pull }
  }
  return { ...ci, pull }
}

async function promoteMaintenance(record) {
  const pull = await ghJson(['api', `repos/${controllerRepository}/pulls/${record.repairPullRequest}`], 'maintenance pull request')
  const files = await validateMaintenancePullRequest(record, pull)
  const decision = assessMaintenancePromotion({ pull, files })
  const current = await ghJson(['api', `repos/${controllerRepository}/pulls/${pull.number}`], 'maintenance pull request before merge')
  confirmMaintenancePromotionHead({ decision, current })
  await run(config.ghExecutable, ['pr', 'merge', String(pull.number), '--repo', controllerRepository,
    '--squash', '--delete-branch', '--match-head-commit', decision.expectedHead], { env: environment })
  const merged = await ghJson(['api', `repos/${controllerRepository}/pulls/${pull.number}`], 'merged maintenance pull request')
  if (!merged.merged || merged.head?.sha !== decision.expectedHead || !/^[0-9a-f]{40}$/.test(merged.merge_commit_sha || '')) {
    throw new Error('Maintenance pull request did not produce a published SHA for the promoted head')
  }
  return merged.merge_commit_sha
}

async function verifyPublishedRuntime(projection, publishedSha) {
  const checkout = publishedSha ? await checkoutControllerAt(publishedSha) : controllerCheckout
  try {
    await run('pwsh', [
      '-NoProfile', '-File', join(checkout, 'scripts', 'install.ps1'),
      '-Configuration', configPath, '-Migrate', '-ConfirmMigration',
    ], { env: environment, timeoutMs: 30 * 60 * 1000 })
    await run('pwsh', componentArgs(projection, 'status', checkout), { env: environment, timeoutMs: 10 * 60 * 1000 })
  } finally {
    if (publishedSha) await rm(checkout, { recursive: true, force: true })
  }
}

async function resumeOriginal(record, faultIssue) {
  for (const requestId of record.rootRequestIds) {
    const match = /^(issue|pull-request)-(\d+)$/.exec(requestId)
    if (!match) continue
    await run(config.ghExecutable, ['api', '--method', 'POST', `repos/${record.repository}/dispatches`,
      '-f', 'event_type=automation_fault_recovered',
      '-f', `client_payload[repository]=${record.repository}`,
      '-f', `client_payload[subject_type]=${match[1]}`,
      '-F', `client_payload[subject_number]=${match[2]}`,
      '-F', `client_payload[fault_issue_number]=${faultIssue.number}`,
      '-f', `client_payload[fault_id]=${record.faultId}`], { env: environment })
  }
  await run(config.ghExecutable, ['issue', 'close', String(faultIssue.number), '--repo', record.repository,
    '--comment', `Recovered by Controller maintenance run https://github.com/${controllerRepository}/actions/runs/${runId}.`], { env: environment })
}

async function processFault(issue) {
  let projection
  try { projection = parseFaultProjection(issue.body) } catch { return }
  if (!await verifyProjection(issue, projection)) return
  const comments = await pages(`repos/${projection.repository}/issues/${issue.number}/comments`, 'fault state comments')
  const attestations = await trustedFaultRecords({
    comments,
    faultId: projection.faultId,
    controllerRepository,
    loadRun: candidateRunId => ghJson(['api', `repos/${controllerRepository}/actions/runs/${candidateRunId}`], 'Controller maintenance run'),
  })
  const healthGeneration = await observeComponentHealth(projection)
  const stateVersion = await localStateVersion(projection, healthGeneration)
  let record = attestations.at(-1)?.record
  if (!record) {
    record = createFaultRecord({ ...projection, stateVersion, now: new Date().toISOString() })
    await appendRecord(projection.repository, issue.number, record)
    return
  }
  record = attachRootRequests(record, projection.rootRequestIds)
  if (record.status === 'recovered') {
    await resumeOriginal(record, issue)
    return
  }
  if (record.status === 'circuit-open') {
    try {
      record = beginFaultEpoch(record, { stateVersion, now: new Date().toISOString(), maxEpochsPer24Hours: profile.limits.maxEpochsPer24Hours })
    } catch (error) {
      if (/changed stateVersion|rolling epoch budget/.test(error.message)) {
        return
      }
      throw error
    }
    await appendRecord(projection.repository, issue.number, record)
    return
  }
  const epoch = record.epochs.at(-1).number
  const attempts = record.attempts.filter(attempt => attempt.epoch === epoch)
  if (record.status === 'reviewing' && record.repairPullRequest) {
    if (!attempts.some(attempt => attempt.kind === 'review')) {
      try {
        const { review } = await reviewMaintenancePullRequest(record)
        record = recordFaultAttempt(record, {
          kind: 'review', target: reviewWorker, sequence: 1,
          outcome: review.verdict === 'pass' ? 'succeeded' : 'failed',
          detail: review.summary.slice(0, 500), at: new Date().toISOString(),
        })
      } catch (error) {
        record = recordFaultAttempt(record, {
          kind: 'review', target: reviewWorker, sequence: 1, outcome: 'failed',
          detail: error.message.slice(0, 500), at: new Date().toISOString(),
        })
      }
      await appendRecord(projection.repository, issue.number, record)
      return
    }
    if (!attempts.some(attempt => attempt.kind === 'ci')) {
      const ci = await checkMaintenanceCi(record)
      if (ci.outcome === 'waiting') return
      record = recordFaultAttempt(record, {
        kind: 'ci', target: profile.checks.workflowNames[0].replace(/\s+/g, '-').toLowerCase(), sequence: 1,
        outcome: ci.outcome, ...(ci.detail ? { detail: ci.detail } : {}), at: new Date().toISOString(),
      })
      await appendRecord(projection.repository, issue.number, record)
      return
    }
  }
  if (record.status === 'deploying') {
    try {
      const publishedSha = await promoteMaintenance(record)
      record = recordFaultAttempt(record, {
        kind: 'promotion', target: 'fault-bound', sequence: 1, outcome: 'succeeded',
        publishedSha, at: new Date().toISOString(),
      })
    } catch (error) {
      record = recordFaultAttempt(record, {
        kind: 'promotion', target: 'fault-bound', sequence: 1, outcome: 'failed',
        detail: error.message.slice(0, 500), at: new Date().toISOString(),
      })
    }
    await appendRecord(projection.repository, issue.number, record)
    return
  }
  if (record.status === 'verifying') {
    try {
      await verifyPublishedRuntime(projection, record.publishedSha)
      const sequence = attempts.filter(attempt => attempt.kind === 'verification').length + 1
      record = recordFaultAttempt(record, {
        kind: 'verification', target: profile.verification.procedure, sequence, outcome: 'succeeded',
        requiredSamples: profile.verification.healthySamples,
        detail: `healthy sample ${sequence} of ${profile.verification.healthySamples}`,
        at: new Date().toISOString(),
      })
    } catch (error) {
      record = openFaultCircuit(record, `runtime verification failed: ${error.message}`.slice(0, 500))
    }
    await appendRecord(projection.repository, issue.number, record)
    return
  }

  const action = nextFaultAction({ record, profile, maintenanceWorkers, now: new Date().toISOString() })
  if (action.action === 'wait') return
  if (action.action === 'open-circuit') {
    await appendRecord(projection.repository, issue.number, openFaultCircuit(record, action.reason))
    return
  }
  if (action.action === 'deterministic') {
    try {
      await executeDeterministic(action, projection)
      record = recordFaultAttempt(record, {
        kind: 'deterministic', target: action.target, sequence: action.sequence, outcome: 'succeeded', at: new Date().toISOString(),
      })
    } catch (error) {
      record = recordFaultAttempt(record, {
        kind: 'deterministic', target: action.target, sequence: action.sequence, outcome: 'failed',
        detail: error.message.slice(0, 500), at: new Date().toISOString(),
      })
    }
    await appendRecord(projection.repository, issue.number, record)
    return
  }
  if (action.action === 'maintenance-worker') {
    try {
      const pull = await executeMaintenanceWorker(record, action, issue.number)
      record = recordFaultAttempt(record, {
        kind: 'maintenance-worker', target: action.target, sequence: action.sequence, outcome: 'succeeded',
        repairPullRequest: pull.number, at: new Date().toISOString(),
      })
    } catch (error) {
      record = recordFaultAttempt(record, {
        kind: 'maintenance-worker', target: action.target, sequence: action.sequence, outcome: 'failed',
        detail: error.message.slice(0, 500), at: new Date().toISOString(),
      })
    }
    await appendRecord(projection.repository, issue.number, record)
  }
}

for (const repository of config.repositories) {
  const issues = (await pages(`repos/${repository}/issues?state=open&labels=automation%2Ffault`, 'open fault projections'))
    .filter(issue => !issue.pull_request)
  for (const issue of issues) await processFault(issue)
}
