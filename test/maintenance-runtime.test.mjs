import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  maintenanceCredentialEnvironment,
  validateMaintenanceWorkerCredentials,
  validateWorkerCapabilities,
} from '../src/common.mjs'

test('maintenance workflows route one exact replica without granting hosted mutation authority', async () => {
  const maintenance = await readFile(new URL('../.github/workflows/controller-maintenance.yml', import.meta.url), 'utf8')
  const readiness = await readFile(new URL('../.github/workflows/controller-maintenance-readiness.yml', import.meta.url), 'utf8')
  const resume = await readFile(new URL('../.github/workflows/resume-fault.yml', import.meta.url), 'utf8')
  for (const workflow of [maintenance, readiness]) {
    assert.match(workflow, /AGENT_AUTOMATION_MAINTENANCE_REPLICA_ID/)
    assert.match(workflow, /runs-on: ubuntu-latest/)
    assert.match(workflow, /needs: routing/)
    assert.match(workflow, /AGENT_AUTOMATION_MAINTENANCE_REPLICA_ID is missing or invalid/)
    assert.doesNotMatch(workflow, /runs-on: \[self-hosted, agent-maintenance\]/)
  }
  assert.match(maintenance, /^  actions: read$/m)
  assert.match(maintenance, /^  contents: read$/m)
  assert.doesNotMatch(maintenance, /^  (?:issues|pull-requests|checks): write$/m)
  assert.match(resume, /contents: write/)
  assert.match(resume, /issues: write/)
})

test('maintenance readiness reports the exact failing Worker stage', async () => {
  const source = await readFile(new URL('../src/maintenance-readiness.mjs', import.meta.url), 'utf8')
  assert.match(source, /let stage = 'CLI health'/)
  assert.match(source, /stage = 'GitHub identity'/)
  assert.match(source, /stage = 'Controller repository access'/)
  assert.match(source, /unavailable\.join\('; '\)/)
})

test('maintenance review selects one Worker from the configured review default route', async () => {
  const [source, fixture] = await Promise.all([
    readFile(new URL('../src/maintenance-recovery.mjs', import.meta.url), 'utf8'),
    readFile(new URL('./fixtures/worker-routing.json', import.meta.url), 'utf8').then(JSON.parse),
  ])
  assert.notEqual(fixture.workerIds[0], fixture.expected.default[0])
  assert.match(source, /const \[reviewWorker\] = resolveWorkerCandidates\(\{ config, role: 'review', routeDecision: \{ route: 'default' \} \}\)/)
  assert.doesNotMatch(source, /const \[reviewWorker\] = resolveRoleWorkers\(config, 'review'\)/)
})

test('maintenance CI records only the public exact-run provenance decision', async () => {
  const source = await readFile(new URL('../src/maintenance-recovery.mjs', import.meta.url), 'utf8')
  assert.match(source, /actions\/runs\?event=pull_request&head_sha=\$\{pull\.head\.sha\}/)
  assert.match(source, /assessMaintenanceCi\(\{[\s\S]*requiredCheckNames: profile\.checks\.requiredChecks/)
})

test('maintenance Workers have an independent role and GitHub credential store', () => {
  const credentialIsolationDir = join(tmpdir(), 'agent-maintenance-credentials')
  const maintenanceCapabilities = {
    skills: ['controller-maintenance-repair', 'agent-readiness-canary'],
    hardReadOnlyReview: false,
    trustDomain: 'maintenance',
  }
  const config = {
    workers: {
      change: {
        adapter: 'dsh-web',
        capabilities: { skills: ['github-issue-work', 'github-pr-repair', 'agent-readiness-canary'], hardReadOnlyReview: false, trustDomain: 'change' },
      },
      review: {
        adapter: 'codex-app',
        capabilities: { skills: ['github-pr-review', 'github-repository-supervision', 'agent-readiness-canary'], hardReadOnlyReview: true, trustDomain: 'review' },
      },
      maintenance: {
        adapter: 'opencode-cli', mode: 'maintenance', capabilities: maintenanceCapabilities,
        credentialIsolationDir, githubLogin: 'maintenance-bot',
      },
    },
    operations: {
      roles: {
        change: { workers: ['change'] },
        review: { workers: ['review'] },
        maintenance: { workers: ['maintenance'] },
      },
      repositoryMappings: [{ repository: 'owner/repository' }],
    },
    repositories: ['owner/repository'],
  }
  assert.doesNotThrow(() => validateWorkerCapabilities(config))
  assert.doesNotThrow(() => validateMaintenanceWorkerCredentials(config))
  const environment = maintenanceCredentialEnvironment(config.workers.maintenance, {}, {
    PATH: 'path', GH_TOKEN: 'actions', GITHUB_TOKEN: 'actions', GH_CONFIG_DIR: 'shared',
  })
  assert.equal(environment.GH_CONFIG_DIR, credentialIsolationDir)
  assert.equal(environment.GH_TOKEN, undefined)
  assert.equal(environment.GITHUB_TOKEN, undefined)
  assert.equal(environment.GH_PROMPT_DISABLED, '1')
})
