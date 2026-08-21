import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { checkAgentWorker, normalizeWorkerConfig, runAgentWorker, runRoleWorker } from '../src/agent-worker.mjs'
import { createAgentAdapters } from '../src/agent-adapters.mjs'
import { parseClaudeCodeOutput } from '../src/claude-code-cli.mjs'
import { parseOpenCodeRunOutput } from '../src/opencode-cli.mjs'
import { capacityRecordKey, createCapacityRegistry } from '../src/capacity-registry-store.mjs'
import { projectWorkerCapacityIdentity } from '../src/capacity-registry.mjs'
import { classifyAndCreateWorkerRouteDecision } from '../src/worker-routing.mjs'

test('a controller invokes any configured worker through one interface', async () => {
  const invocations = []
  const receipt = await runAgentWorker({
    config: {
      workers: {
        reviewer: { adapter: 'fake', runnerLabels: ['self-hosted', 'reviewer'] },
      },
    },
    workerId: 'reviewer',
    invocation: {
      taskId: 'pr-12-base-head',
      cwd: 'F:\\checkout',
      title: 'Review PR #12',
      prompt: 'Review the exact pair.',
      timeoutMs: 60_000,
    },
    adapters: {
      fake: async input => {
        invocations.push(input)
        return { sessionId: 'review-session', outcome: 'completed', output: 'PASS' }
      },
    },
  })

  assert.equal(invocations[0].workerId, 'reviewer')
  assert.equal(invocations[0].invocation.taskId, 'pr-12-base-head')
  assert.deepEqual(receipt, {
    workerId: 'reviewer',
    worker: { id: 'reviewer', adapter: 'fake', displayName: 'fake' },
    sessionId: 'review-session',
    outcome: 'completed',
    detail: '',
    output: 'PASS',
  })
})

function roleConfig(role = 'change') {
  return {
    operations: {
      roles: {
        change: { workers: ['primary', 'fallback'] },
        review: { workers: ['primary', 'fallback'] },
      },
      routing: {
        change: { maxCandidates: 8, routes: { default: { selectors: [{ worker: 'primary' }, { worker: 'fallback' }] } } },
        review: { maxCandidates: 8, routes: { default: { selectors: [{ worker: 'primary' }, { worker: 'fallback' }] } } },
      },
    },
    workers: {
      primary: { adapter: 'fake', mode: role, capacityGroup: 'group-primary', capabilities: { hardReadOnlyReview: true } },
      fallback: { adapter: 'fake', mode: role, capacityGroup: 'group-fallback', capabilities: { hardReadOnlyReview: true } },
    },
  }
}

function roleInvocation(overrides = {}) {
  return {
    taskId: 'role-work-1',
    cwd: 'F:\\checkout',
    title: 'Role work',
    prompt: 'Perform the role work.',
    timeoutMs: 60_000,
    ...overrides,
  }
}

function capacityError(phase = 'pre-session') {
  const error = new Error('provider quota exhausted')
  error.adapterFailure = {
    version: 1,
    category: 'capacity',
    reason: 'quota-exhausted',
    scope: 'capacity-group',
    phase,
    code: 'provider.usage-limit',
    confidence: 'authoritative',
  }
  return error
}

const routePolicy = { routes: { default: {} } }

function durableRouteDecision(workRequest, stateVersion = 'c'.repeat(64)) {
  return classifyAndCreateWorkerRouteDecision({
    workRequest,
    subjectStateVersion: stateVersion,
    routingPolicy: routePolicy,
  })
}

function fakeRegistry({ closed = false, failures = [], attempts = [] } = {}) {
  return {
    async get(key) {
      return closed ? {
        version: 1,
        capacityGroup: 'closed',
        scope: 'capacity-group',
        state: 'disabled',
        reason: 'billing-disabled',
        code: 'billing.disabled',
        observedAt: '2026-08-21T00:00:00.000Z',
        retryAtUtc: null,
        sourceWorker: 'primary',
        capacityIdentity: { provider: null, model: null, worker: null },
        configurationHash: 'a'.repeat(64),
        credentialGeneration: 'generation-1',
        generation: 2,
        lease: null,
      } : null
    },
    async recordFailure(input) { failures.push(input); return null },
    async appendAttempt(input) { attempts.push(input); return input },
  }
}

test('runRoleWorker fails over a review capacity error within one exact invocation', async () => {
  const calls = []
  const failures = []
  const attempts = []
  let first = true
  const result = await runRoleWorker({
    config: roleConfig('review'),
    role: 'review',
    invocation: roleInvocation(),
    capacityRegistry: fakeRegistry({ failures, attempts }),
    adapters: {
      fake: async input => {
        calls.push(input)
        if (first) { first = false; throw capacityError('session') }
        return { sessionId: 'review-fallback', outcome: 'completed', output: 'VERDICT: PASS' }
      },
    },
  })

  assert.equal(result.workerId, 'fallback')
  assert.equal(result.outcome, 'completed')
  assert.deepEqual(calls.map(call => call.workerId), ['primary', 'fallback'])
  assert.equal(calls[0].invocation.cwd, calls[1].invocation.cwd)
  assert.equal(failures.length, 1)
  assert.equal(failures[0].sourceWorker, 'primary')
  assert.deepEqual(
    attempts.filter(attempt => attempt.result.outcome !== 'claimed').map(attempt => attempt.result.outcome),
    ['capacity-failure', 'completed'],
  )
})

test('runRoleWorker permits only pre-session change failover', async () => {
  const calls = []
  let first = true
  const result = await runRoleWorker({
    config: roleConfig('change'), role: 'change',
    invocation: roleInvocation(), capacityRegistry: fakeRegistry(),
    adapters: {
      fake: async input => {
        calls.push(input.workerId)
        if (first) { first = false; throw capacityError() }
        return { sessionId: 'change-fallback', outcome: 'completed', output: 'done' }
      },
    },
  })
  assert.equal(result.workerId, 'fallback')
  assert.deepEqual(calls, ['primary', 'fallback'])

  first = true
  await assert.rejects(runRoleWorker({
    config: roleConfig('change'), role: 'change',
    invocation: roleInvocation(), capacityRegistry: fakeRegistry(),
    adapters: {
      fake: async ({ invocation }) => {
        if (first) {
          first = false
          await invocation.onStarted({ sessionId: 'accepted-turn' })
          throw capacityError('session')
        }
        return { sessionId: 'must-not-run', outcome: 'completed', output: 'done' }
      },
    },
  }), error => error.adapterFailure?.phase === 'session')
})

test('runRoleWorker returns structured capacity-deferred when every candidate is closed', async () => {
  const result = await runRoleWorker({
    config: roleConfig('change'), role: 'change',
    invocation: roleInvocation(), capacityRegistry: fakeRegistry({ closed: true }),
    adapters: { fake: async () => { throw new Error('must not invoke a closed candidate') } },
  })
  assert.equal(result.outcome, 'capacity-deferred')
  assert.equal(result.category, 'capacity')
  assert.equal(result.reason, 'capacity-deferred')
  assert.deepEqual(result.candidates, ['primary', 'fallback'])
})

test('all-preclosed trusted generation records a deferred receipt and replays without invoking a Worker', async () => {
  const stateRoot = await mkdtemp(path.join(tmpdir(), 'dsh-role-deferred-replay-'))
  const config = roleConfig('review')
  config.operations.stateRoot = stateRoot
  config.configurationHash = 'a'.repeat(64)
  config.credentialGeneration = 'generation-1'
  const attempts = new Map()
  const registry = {
    async get() {
      return {
        version: 1, capacityGroup: 'closed', scope: 'capacity-group', state: 'disabled',
        reason: 'billing-disabled', code: 'billing.disabled', observedAt: '2026-08-21T00:00:00.000Z',
        retryAtUtc: null, sourceWorker: 'primary', capacityIdentity: { provider: null, model: null, worker: null },
        configurationHash: config.configurationHash, credentialGeneration: config.credentialGeneration,
        generation: 2, lease: null,
      }
    },
    async claimAttempt(input) {
      const existing = attempts.get(input.attemptId)
      if (existing) return { claimed: false, attempt: existing }
      attempts.set(input.attemptId, input)
      return { claimed: true, attempt: input }
    },
    async appendAttempt(input) { attempts.set(input.attemptId, input); return input },
  }
  const previousRunId = process.env.GITHUB_RUN_ID
  const previousRunAttempt = process.env.GITHUB_RUN_ATTEMPT
  let invocations = 0
  let ready = 0
  try {
    process.env.GITHUB_RUN_ID = '9301'
    process.env.GITHUB_RUN_ATTEMPT = '1'
    const input = {
      config, role: 'review', workRequest: { requestId: 'all-closed-review', role: 'review' },
      subjectStateVersion: 'd'.repeat(64), trustedTaskSnapshot: { workflowStage: 'review' },
      capacityRegistry: registry, invocation: roleInvocation(),
      onCandidateReady: async () => { ready += 1 },
      adapters: { fake: async () => { invocations += 1; return { sessionId: 'never', outcome: 'completed' } } },
    }
    const first = await runRoleWorker(input)
    const attemptCount = attempts.size
    const replay = await runRoleWorker(input)
    assert.equal(first.outcome, 'capacity-deferred')
    assert.equal(replay.outcome, 'replayed')
    assert.equal(invocations, 0)
    assert.equal(ready, 0)
    assert.equal(attempts.size, attemptCount)
    assert.ok([...attempts.values()].some(attempt => attempt.result.outcome === 'capacity-deferred'))
  } finally {
    if (previousRunId === undefined) delete process.env.GITHUB_RUN_ID
    else process.env.GITHUB_RUN_ID = previousRunId
    if (previousRunAttempt === undefined) delete process.env.GITHUB_RUN_ATTEMPT
    else process.env.GITHUB_RUN_ATTEMPT = previousRunAttempt
    await rm(stateRoot, { recursive: true, force: true })
  }
})

test('runRoleWorker closes a shared capacity group before considering its next candidate', async () => {
  const stateRoot = await mkdtemp(path.join(tmpdir(), 'dsh-role-capacity-'))
  const config = roleConfig('change')
  config.operations.stateRoot = stateRoot
  config.configurationHash = 'a'.repeat(64)
  config.credentialGeneration = 'generation-1'
  config.workers.primary.capacityGroup = 'shared-group'
  config.workers.fallback.capacityGroup = 'shared-group'
  let calls = 0
  try {
    const result = await runRoleWorker({
      config,
      role: 'change',
      invocation: roleInvocation(),
      adapters: {
        fake: async () => {
          calls += 1
          throw capacityError()
        },
      },
    })
    assert.equal(result.outcome, 'capacity-deferred')
    assert.equal(calls, 1)
    const registry = createCapacityRegistry({
      stateRoot,
      configurationHash: config.configurationHash,
      credentialGeneration: config.credentialGeneration,
      workers: config.workers,
    })
    const key = capacityRecordKey({ capacityGroup: 'shared-group', scope: 'capacity-group' })
    assert.equal((await registry.get(key)).reason, 'quota-exhausted')
  } finally {
    await rm(stateRoot, { recursive: true, force: true })
  }
})

test('runRoleWorker keeps non-capacity failures on the original recovery path', async () => {
  const calls = []
  await assert.rejects(runRoleWorker({
    config: roleConfig('review'), role: 'review',
    invocation: roleInvocation(), capacityRegistry: fakeRegistry(),
    adapters: { fake: async ({ workerId }) => { calls.push(workerId); throw new Error('task failed') } },
  }), /task failed/)
  assert.deepEqual(calls, ['primary'])
})

test('runRoleWorker derives routing locally and ignores a caller route decision', async () => {
  const workRequest = { requestId: 'role-work-policy', role: 'change' }
  const decision = durableRouteDecision(workRequest)
  const receipt = await runRoleWorker({
    config: roleConfig(), role: 'change', workRequest,
    routeDecision: decision, subjectStateVersion: 'c'.repeat(64), routingPolicy: routePolicy,
    invocation: roleInvocation(), adapters: {
      fake: async ({ workerId }) => ({ sessionId: `session-${workerId}`, outcome: 'completed' }),
    },
  })
  assert.equal(receipt.workerId, 'primary')
  const replay = await runRoleWorker({
    config: roleConfig(), role: 'change', workRequest,
    routeDecision: { ...decision, policyHash: 'd'.repeat(64) },
    subjectStateVersion: 'c'.repeat(64), routingPolicy: routePolicy,
    invocation: roleInvocation(), adapters: {
      fake: async ({ workerId }) => ({ sessionId: workerId, outcome: 'completed' }),
    },
  })
  assert.equal(replay.outcome, 'completed')
})

test('runRoleWorker rejects no caller routing authority', async () => {
  const workRequest = { requestId: 'role-work-1', role: 'change' }
  const arbitrary = await runRoleWorker({
    config: roleConfig(), role: 'change', workRequest,
    routeDecision: { route: 'default' }, subjectStateVersion: 'c'.repeat(64),
    invocation: roleInvocation(), adapters: { fake: async ({ workerId }) => ({ sessionId: workerId, outcome: 'completed' }) },
  })
  assert.equal(arbitrary.outcome, 'completed')
  const decision = durableRouteDecision(workRequest)
  const wrongWorkRequest = await runRoleWorker({
    config: roleConfig(), role: 'change', workRequest,
    routeDecision: { ...decision, workRequestId: 'other-work' }, subjectStateVersion: 'c'.repeat(64),
    invocation: roleInvocation({ taskId: 'role-work-wrong' }), adapters: { fake: async ({ workerId }) => ({ sessionId: workerId, outcome: 'completed' }) },
  })
  assert.equal(wrongWorkRequest.outcome, 'completed')
  const wrongSubject = await runRoleWorker({
    config: roleConfig(), role: 'change', workRequest,
    routeDecision: decision, subjectStateVersion: 'd'.repeat(64),
    invocation: roleInvocation({ taskId: 'role-work-subject' }), adapters: { fake: async ({ workerId }) => ({ sessionId: workerId, outcome: 'completed' }) },
  })
  assert.equal(wrongSubject.outcome, 'completed')
})

test('runRoleWorker claims each candidate before one sequential or concurrent invocation', async () => {
  const claims = new Map()
  const calls = []
  const registry = {
    async get() { return null },
    async claimAttempt(input) {
      const existing = claims.get(input.attemptId)
      if (existing) return { claimed: false, attempt: existing }
      claims.set(input.attemptId, input)
      return { claimed: true, attempt: input }
    },
  }
  const adapters = {
    fake: async ({ workerId }) => {
      calls.push(workerId)
      await new Promise(resolve => setTimeout(resolve, 5))
      return { sessionId: `session-${workerId}`, outcome: 'completed', output: 'done' }
    },
  }
  const first = await runRoleWorker({
    config: roleConfig(), role: 'change', routingAttemptId: 'attempt-one',
    workRequest: { requestId: 'role-work-1', role: 'change' }, invocation: roleInvocation(),
    capacityRegistry: registry, adapters,
  })
  const [second, third] = await Promise.all([
    runRoleWorker({
      config: roleConfig(), role: 'change', routingAttemptId: 'attempt-two',
      workRequest: { requestId: 'role-work-1', role: 'change' }, invocation: roleInvocation(),
      capacityRegistry: registry, adapters,
    }),
    runRoleWorker({
      config: roleConfig(), role: 'change', routingAttemptId: 'attempt-two',
      workRequest: { requestId: 'role-work-1', role: 'change' }, invocation: roleInvocation(),
      capacityRegistry: registry, adapters,
    }),
  ])
  assert.equal(first.workerId, 'primary')
  assert.deepEqual([second.outcome, third.outcome].sort(), ['replayed', 'replayed'])
  assert.equal(calls.length, 1)
})

test('real registry claim makes same routing generation idempotent and accepts a new generation', async () => {
  const stateRoot = await mkdtemp(path.join(tmpdir(), 'dsh-role-attempt-identity-'))
  const config = roleConfig()
  config.operations.stateRoot = stateRoot
  config.configurationHash = 'a'.repeat(64)
  config.credentialGeneration = 'generation-1'
  const calls = []
  const adapters = {
    fake: async ({ workerId }) => {
      calls.push(workerId)
      return { sessionId: `session-${calls.length}`, outcome: 'completed' }
    },
  }
  const previousRunId = process.env.GITHUB_RUN_ID
  const previousRunAttempt = process.env.GITHUB_RUN_ATTEMPT
  try {
    process.env.GITHUB_RUN_ID = '9101'
    process.env.GITHUB_RUN_ATTEMPT = '1'
    const first = await runRoleWorker({
      config, role: 'change', workRequest: { requestId: 'role-work-identity', role: 'change' },
      invocation: roleInvocation(), adapters,
    })
    const replay = await runRoleWorker({
      config, role: 'change', workRequest: { requestId: 'role-work-identity', role: 'change' },
      invocation: roleInvocation(), adapters,
    })
    process.env.GITHUB_RUN_ID = '9102'
    const recovered = await runRoleWorker({
      config, role: 'change', workRequest: { requestId: 'role-work-identity', role: 'change' },
      invocation: roleInvocation(), adapters,
    })
    assert.equal(first.outcome, 'completed')
    assert.equal(replay.outcome, 'replayed')
    assert.equal(recovered.outcome, 'completed')
    assert.deepEqual(calls, ['primary', 'primary'])
  } finally {
    if (previousRunId === undefined) delete process.env.GITHUB_RUN_ID
    else process.env.GITHUB_RUN_ID = previousRunId
    if (previousRunAttempt === undefined) delete process.env.GITHUB_RUN_ATTEMPT
    else process.env.GITHUB_RUN_ATTEMPT = previousRunAttempt
    await rm(stateRoot, { recursive: true, force: true })
  }
})

test('Worker derives a non-default route from local policy and ignores a transported envelope', async () => {
  const stateRoot = await mkdtemp(path.join(tmpdir(), 'dsh-local-routing-'))
  const config = roleConfig()
  config.operations.stateRoot = stateRoot
  config.configurationHash = 'a'.repeat(64)
  config.credentialGeneration = 'generation-1'
  config.operations.routing.change.routes = {
    frontend: { rules: { labelsAny: ['ui'] }, selectors: [{ worker: 'fallback' }] },
    default: { selectors: [{ worker: 'primary' }] },
  }
  const previousRunId = process.env.GITHUB_RUN_ID
  const previousRunAttempt = process.env.GITHUB_RUN_ATTEMPT
  try {
    process.env.GITHUB_RUN_ID = '9001'
    process.env.GITHUB_RUN_ATTEMPT = '1'
    const result = await runRoleWorker({
      config,
      role: 'change',
      workRequest: { requestId: 'local-route-work', role: 'change' },
      subjectStateVersion: 'c'.repeat(64),
      trustedTaskSnapshot: { labels: ['ui'], workflowStage: 'change' },
      routingExecution: { version: 1, routingAttemptId: 'forged', routeDecision: { route: 'default' } },
      invocation: roleInvocation(),
      adapters: { fake: async ({ workerId }) => ({ sessionId: workerId, outcome: 'completed' }) },
    })
    assert.equal(result.workerId, 'fallback')
  } finally {
    if (previousRunId === undefined) delete process.env.GITHUB_RUN_ID
    else process.env.GITHUB_RUN_ID = previousRunId
    if (previousRunAttempt === undefined) delete process.env.GITHUB_RUN_ATTEMPT
    else process.env.GITHUB_RUN_ATTEMPT = previousRunAttempt
    await rm(stateRoot, { recursive: true, force: true })
  }
})

test('same local routing generation is a replay no-op before capacity inspection or invocation', async () => {
  const stateRoot = await mkdtemp(path.join(tmpdir(), 'dsh-routing-replay-'))
  const config = roleConfig()
  config.operations.stateRoot = stateRoot
  config.configurationHash = 'a'.repeat(64)
  config.credentialGeneration = 'generation-1'
  const calls = []
  let ready = 0
  const adapters = { fake: async ({ workerId }) => {
    calls.push(workerId)
    return { sessionId: workerId, outcome: 'completed' }
  } }
  const previousRunId = process.env.GITHUB_RUN_ID
  const previousRunAttempt = process.env.GITHUB_RUN_ATTEMPT
  try {
    process.env.GITHUB_RUN_ID = '9002'
    process.env.GITHUB_RUN_ATTEMPT = '1'
    const first = await runRoleWorker({
      config, role: 'change', workRequest: { requestId: 'replay-work', role: 'change' },
      subjectStateVersion: 'd'.repeat(64), trustedTaskSnapshot: { workflowStage: 'change' },
      invocation: roleInvocation(), onCandidateReady: async () => { ready += 1 }, adapters,
    })
    const replay = await runRoleWorker({
      config, role: 'change', workRequest: { requestId: 'replay-work', role: 'change' },
      subjectStateVersion: 'd'.repeat(64), trustedTaskSnapshot: { workflowStage: 'change' },
      invocation: roleInvocation(), onCandidateReady: async () => { ready += 1 }, adapters,
    })
    assert.equal(first.outcome, 'completed')
    assert.equal(replay.outcome, 'replayed')
    assert.deepEqual(calls, ['primary'])
    assert.equal(ready, 1)
  } finally {
    if (previousRunId === undefined) delete process.env.GITHUB_RUN_ID
    else process.env.GITHUB_RUN_ID = previousRunId
    if (previousRunAttempt === undefined) delete process.env.GITHUB_RUN_ATTEMPT
    else process.env.GITHUB_RUN_ATTEMPT = previousRunAttempt
    await rm(stateRoot, { recursive: true, force: true })
  }
})

test('capacity attempt identity changes when any applicable scope generation changes', async () => {
  const config = roleConfig()
  config.workers.primary.capacityGroup = 'vector-group'
  const identity = projectWorkerCapacityIdentity('primary', config.workers.primary)
  const keys = {
    group: capacityRecordKey({ capacityGroup: 'vector-group', scope: 'capacity-group' }),
    worker: capacityRecordKey({ capacityGroup: 'vector-group', scope: 'worker', identity }),
  }
  let workerGeneration = 1
  const attempts = new Map()
  const record = (scope, generation) => ({
    version: 1,
    capacityGroup: 'vector-group',
    scope,
    state: 'available',
    reason: null,
    code: null,
    observedAt: new Date().toISOString(),
    retryAtUtc: null,
    sourceWorker: scope === 'worker' ? 'primary' : null,
    capacityIdentity: scope === 'worker' ? identity : { provider: null, model: null, worker: null },
    configurationHash: 'a'.repeat(64),
    credentialGeneration: 'generation-1',
    generation,
    lease: null,
  })
  const registry = {
    async get(key) {
      if (key === keys.group) return record('capacity-group', 5)
      if (key === keys.worker) return record('worker', workerGeneration)
      return null
    },
    async claimAttempt(input) {
      const existing = attempts.get(input.attemptId)
      if (existing) return { claimed: false, attempt: existing }
      attempts.set(input.attemptId, input)
      return { claimed: true, attempt: input }
    },
  }
  const calls = []
  const run = () => runRoleWorker({
    config,
    role: 'change',
    workRequest: { requestId: 'scope-vector-work', role: 'change' },
    subjectStateVersion: 'e'.repeat(64),
    capacityRegistry: registry,
    invocation: roleInvocation(),
    adapters: { fake: async ({ workerId }) => { calls.push(workerId); return { sessionId: workerId, outcome: 'completed' } } },
  })
  const first = await run()
  workerGeneration = 2
  const second = await run()
  const claimed = [...attempts.values()]
  assert.equal(first.outcome, 'completed')
  assert.equal(second.outcome, 'completed')
  assert.deepEqual(calls, ['primary', 'primary'])
  assert.equal(claimed.length, 2)
  assert.notEqual(claimed[0].attemptId, claimed[1].attemptId)
  assert.notEqual(claimed[0].capacityGenerationHash, claimed[1].capacityGenerationHash)
})

test('runRoleWorker allows a new capacity generation but does not switch command-json mutation', async () => {
  let generation = 1
  const calls = []
  const claims = new Map()
  const registry = {
    async get() {
      return {
        version: 1, capacityGroup: 'group-primary', scope: 'capacity-group', state: 'available',
        reason: null, code: null, observedAt: new Date().toISOString(), retryAtUtc: null,
        sourceWorker: null, capacityIdentity: { provider: null, model: null, worker: null },
        configurationHash: 'a'.repeat(64), credentialGeneration: 'generation-1', generation, lease: null,
      }
    },
    async appendAttempt(input) {
      if (claims.has(input.attemptId)) return claims.get(input.attemptId)
      claims.set(input.attemptId, input)
      return input
    },
  }
  const config = roleConfig()
  const first = await runRoleWorker({
    config, role: 'change', routingAttemptId: 'new-generation',
    workRequest: { requestId: 'role-work-1', role: 'change' }, invocation: roleInvocation(),
    capacityRegistry: registry, adapters: { fake: async ({ workerId }) => { calls.push(workerId); return { sessionId: workerId, outcome: 'completed' } } },
  })
  generation += 1
  const second = await runRoleWorker({
    config, role: 'change', routingAttemptId: 'new-generation',
    workRequest: { requestId: 'role-work-1', role: 'change' }, invocation: roleInvocation(),
    capacityRegistry: registry, adapters: { fake: async ({ workerId }) => { calls.push(workerId); return { sessionId: workerId, outcome: 'completed' } } },
  })
  assert.equal(first.outcome, 'completed')
  assert.equal(second.outcome, 'completed')
  assert.deepEqual(calls, ['primary', 'primary'])

  const commandConfig = roleConfig()
  commandConfig.workers.primary.adapter = 'command-json'
  let fallbackCalls = 0
  const commandResult = await assert.rejects(runRoleWorker({
    config: commandConfig, role: 'change', workRequest: { requestId: 'role-work-command', role: 'change' },
    invocation: roleInvocation(), capacityRegistry: fakeRegistry(), adapters: {
      'command-json': async ({ invocation }) => {
        await invocation.onStarted({ sessionId: 'mutation-turn' })
        throw capacityError('session')
      },
      fake: async () => { fallbackCalls += 1; return { sessionId: 'fallback', outcome: 'completed' } },
    },
  }), error => error.adapterFailure?.phase === 'session')
  assert.equal(commandResult, undefined)
  assert.equal(fallbackCalls, 0)
})

test('runRoleWorker abandons a claimed half-open probe when setup throws before invocation', async () => {
  const outcomes = []
  const claims = new Map()
  const groupKey = capacityRecordKey({ capacityGroup: 'group-primary', scope: 'capacity-group' })
  const registry = {
    async get(key) {
      if (key !== groupKey) return null
      return {
        version: 1, capacityGroup: 'group-primary', scope: 'capacity-group', state: 'cooldown',
        reason: 'rate-limited', code: 'provider.rate-limit', observedAt: new Date(Date.now() - 5_000).toISOString(),
        retryAtUtc: new Date(Date.now() - 1_000).toISOString(), sourceWorker: null,
        capacityIdentity: { provider: null, model: null, worker: null }, configurationHash: 'a'.repeat(64),
        credentialGeneration: 'generation-1', generation: 1, lease: null,
      }
    },
    async acquireHalfOpenLease({ key, leaseId }) {
      return { record: { generation: 2 }, lease: { key, leaseId } }
    },
    async completeHalfOpenLease({ outcome }) { outcomes.push(outcome) },
    async claimAttempt(input) {
      const existing = claims.get(input.attemptId)
      return existing ? { claimed: false, attempt: existing } : (claims.set(input.attemptId, input), { claimed: true, attempt: input })
    },
  }
  let invocations = 0
  let budgetWrites = 0
  await assert.rejects(runRoleWorker({
    config: roleConfig(), role: 'change',
    workRequest: { requestId: 'role-work-1', role: 'change' }, invocation: roleInvocation(),
    capacityRegistry: registry, onCandidateReady: async () => { throw new Error('checkout setup failed') },
    adapters: { fake: async () => { invocations += 1; return { sessionId: 'never', outcome: 'completed' } } },
  }), /checkout setup failed/)
  assert.equal(invocations, 0)
  assert.equal(budgetWrites, 0)
  assert.deepEqual(outcomes, ['abandon'])
})

test('deferred role scripts keep checkout cleanup in finally before returning', async () => {
  for (const script of ['dsh-issue.mjs', 'dsh-repair.mjs']) {
    const source = await readFile(new URL(`../src/${script}`, import.meta.url), 'utf8')
    const jobStart = source.indexOf('const jobPath')
    assert.ok(jobStart >= 0, `${script} must create a tracked job directory`)
    const jobBody = source.slice(jobStart)
    assert.doesNotMatch(jobBody, /process\.exit\(0\)/)
    assert.match(jobBody, /finally \{[\s\S]*removeJobDirectory/)
  }
})

test('worker configuration accepts explicit adapters and rejects removed legacy fields', () => {
  const explicit = normalizeWorkerConfig({
    workers: {
      luna: { adapter: 'command-json', executable: 'luna.exe' },
    },
  })
  assert.equal(explicit.workers.luna.adapter, 'command-json')

  assert.throws(() => normalizeWorkerConfig({
    dshWebBaseUrl: 'http://localhost:3080',
    codexNode: 'node.exe',
    codexScript: 'codex.js',
    codexHome: 'F:\\CodexData',
    codexProjectCwd: 'F:\\repo',
  }), /must declare workers/)
})

test('a command-json adapter lets a new agent join without controller changes', async () => {
  const calls = []
  const adapters = createAgentAdapters({
    runCommand: async (command, args, options) => {
      calls.push({ command, args, options })
      return {
        stdout: JSON.stringify({
          sessionId: 'luna-42', outcome: 'completed', detail: 'done', output: 'result',
        }),
      }
    },
  })
  const receipt = await runAgentWorker({
    config: {
      workers: {
        luna: {
          adapter: 'command-json',
          executable: 'F:\\agents\\luna.exe',
          args: ['run-json'],
          mode: 'change',
        },
      },
    },
    workerId: 'luna',
    invocation: {
      taskId: 'issue-42', cwd: 'F:\\checkout', title: 'Issue 42',
      prompt: 'Implement the issue.', timeoutMs: 90_000, signal: new AbortController().signal,
    },
    adapters,
  })

  assert.equal(calls[0].command, 'F:\\agents\\luna.exe')
  assert.deepEqual(calls[0].args, ['run-json'])
  assert.equal(JSON.parse(calls[0].options.input).taskId, 'issue-42')
  assert.equal(calls[0].options.signal.aborted, false)
  assert.equal(receipt.sessionId, 'luna-42')
  assert.equal(receipt.output, 'result')
})

test('the Claude Code CLI adapter runs change work through the shared worker interface', async () => {
  const calls = []
  const started = []
  let mountedSkill
  let pluginDirectory
  const finalMessage = '完成。\n<!-- agent-automation-result\n{"version":1,"outcome":"completed","summary":"已提交 PR。"}\n-->'
  const adapters = createAgentAdapters({
    runCommand: async (command, args, options) => {
      calls.push({ command, args, options })
      pluginDirectory = args[args.indexOf('--plugin-dir') + 1]
      mountedSkill = await readFile(path.join(
        pluginDirectory, 'skills', 'github-issue-work', 'SKILL.md',
      ), 'utf8')
      const firstEvent = JSON.stringify({ type: 'system', subtype: 'init', session_id: 'claude-change' })
      options.onStdout(`${firstEvent}\n`)
      assert.deepEqual(started, [{ sessionId: 'claude-change' }])
      return {
        stdout: [
          firstEvent,
          JSON.stringify({
            type: 'result', subtype: 'success', is_error: false,
            session_id: 'claude-change', result: finalMessage,
          }),
        ].join('\n'),
        stderr: '',
      }
    },
  })

  const receipt = await runAgentWorker({
    config: { workers: { claude: {
      adapter: 'claude-code-cli', executable: 'claude.exe', mode: 'change',
      model: 'opus', effort: 'max',
    } } },
    workerId: 'claude',
    invocation: {
      taskId: 'issue-repo-42-request', cwd: 'F:\\checkout', title: 'Issue 42',
      prompt: '/github-issue-work {"repository":"owner/repo","issueNumber":42}',
      requiredSkill: 'github-issue-work', timeoutMs: 90_000,
      onStarted: value => started.push(value),
    },
    adapters,
  })

  assert.equal(calls[0].command, 'claude.exe')
  assert.equal(calls[0].args.includes('--permission-mode'), true)
  assert.equal(calls[0].args.includes('bypassPermissions'), true)
  assert.equal(calls[0].args.includes('opus'), true)
  assert.equal(calls[0].args.includes('max'), true)
  assert.equal(calls[0].options.cwd, 'F:\\checkout')
  assert.match(calls[0].options.input, /^\/dsh-github-work:github-issue-work /)
  assert.match(mountedSkill, /^---\nname: github-issue-work\n/)
  await assert.rejects(access(pluginDirectory))
  assert.deepEqual(started, [{ sessionId: 'claude-change' }])
  assert.equal(receipt.sessionId, 'claude-change')
  assert.equal(receipt.outcome, 'completed')
  assert.equal(receipt.detail, '已提交 PR。')
  assert.equal(receipt.output, finalMessage)
})

test('the Claude Code CLI adapter isolates untrusted review work from credentials and writes', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-claude-review-test-'))
  const checkout = path.join(root, 'checkout')
  await mkdir(checkout)
  const base = '3'.repeat(40)
  const head = '4'.repeat(40)
  let claudeCall
  let reviewBundle
  let reviewSkill
  const adapters = createAgentAdapters({
    runCommand: async (command, args, options) => {
      if (command === 'git.exe') {
        if (args.includes('diff')) return { stdout: 'diff --git a/src/b.js b/src/b.js\n+review me\n', stderr: '' }
        if (args.includes('ls-tree')) return { stdout: 'AGENTS.md\nsrc/AGENTS.md\nsrc/b.js\n', stderr: '' }
        if (args.includes('show')) return { stdout: `trusted guidance for ${args.at(-1)}\n`, stderr: '' }
        throw new Error(`Unexpected git invocation: ${args.join(' ')}`)
      }
      claudeCall = { command, args, options }
      reviewBundle = JSON.parse(await readFile(path.join(options.cwd, 'review-input.json'), 'utf8'))
      reviewSkill = await readFile(args[args.indexOf('--append-system-prompt-file') + 1], 'utf8')
      const firstEvent = JSON.stringify({ type: 'system', subtype: 'init', session_id: 'claude-review' })
      options.onStdout(`${firstEvent}\n`)
      return {
        stdout: [
          firstEvent,
          JSON.stringify({
            type: 'result', subtype: 'success', is_error: false,
            session_id: 'claude-review', result: 'VERDICT: PASS',
          }),
        ].join('\n'),
        stderr: '',
      }
    },
  })
  try {
    const receipt = await runAgentWorker({
      config: { workers: { reviewer: {
        adapter: 'claude-code-cli', executable: 'claude.exe', gitExecutable: 'git.exe',
        mode: 'review', model: 'sonnet', effort: 'high',
      } } },
      workerId: 'reviewer',
      invocation: {
        taskId: `review-${base}-${head}`, cwd: checkout, title: 'Review PR #42',
        prompt: 'Review this exact pull request pair.', requiredSkill: 'github-pr-review',
        timeoutMs: 60_000,
      },
      adapters,
    })

    assert.equal(claudeCall.command, 'claude.exe')
    assert.notEqual(claudeCall.options.cwd, checkout)
    assert.equal(claudeCall.args.includes('--setting-sources'), true)
    assert.equal(claudeCall.args.includes('project'), true)
    assert.equal(claudeCall.args.includes('--disable-slash-commands'), true)
    assert.equal(claudeCall.args.includes('dontAsk'), true)
    assert.equal(claudeCall.args.includes('Read,Glob,Grep'), true)
    assert.equal(claudeCall.args.includes('mcp__*'), true)
    assert.equal(claudeCall.args.includes('--strict-mcp-config'), true)
    assert.equal(claudeCall.args.includes('{"mcpServers":{}}'), true)
    assert.equal(claudeCall.args.includes(checkout), true)
    assert.equal(claudeCall.options.env.GH_TOKEN, undefined)
    assert.equal(claudeCall.options.env.GITHUB_TOKEN, undefined)
    assert.equal(claudeCall.options.env.ANTHROPIC_API_KEY, undefined)
    assert.equal(claudeCall.options.env.DEEPSEEK_API_KEY, undefined)
    assert.equal(claudeCall.options.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY, '1')
    assert.equal(claudeCall.options.env.CLAUDE_CODE_DISABLE_CLAUDE_MDS, '1')
    assert.equal(claudeCall.options.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, '1')
    assert.deepEqual(reviewBundle, {
      version: 1,
      base,
      head,
      diff: 'diff --git a/src/b.js b/src/b.js\n+review me\n',
      guidance: {
        'AGENTS.md': `trusted guidance for ${base}:AGENTS.md\n`,
        'src/AGENTS.md': `trusted guidance for ${base}:src/AGENTS.md\n`,
      },
    })
    assert.match(reviewSkill, /^The trusted controller invokes this Skill/)
    assert.equal(receipt.sessionId, 'claude-review')
    assert.equal(receipt.output, 'VERDICT: PASS')
    await assert.rejects(access(claudeCall.options.cwd))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('Claude Code JSON output fails closed on malformed, failed, duplicate, or mixed sessions', () => {
  assert.throws(() => parseClaudeCodeOutput('not-json'), /not valid JSON/)
  assert.throws(() => parseClaudeCodeOutput([
    JSON.stringify({ type: 'system', session_id: 'one' }),
    JSON.stringify({ type: 'result', subtype: 'success', is_error: false, session_id: 'two', result: 'done' }),
  ].join('\n')), /exactly one session_id/)
  assert.throws(() => parseClaudeCodeOutput(JSON.stringify({
    type: 'result', subtype: 'error_max_turns', is_error: true,
    session_id: 'one', result: 'stopped',
  })), /session failed/)
  assert.throws(() => parseClaudeCodeOutput([
    JSON.stringify({ type: 'result', subtype: 'success', is_error: false, session_id: 'one', result: 'one' }),
    JSON.stringify({ type: 'result', subtype: 'success', is_error: false, session_id: 'one', result: 'two' }),
  ].join('\n')), /exactly one result/)
})

test('the OpenCode CLI adapter runs change work through the shared worker interface', async () => {
  const calls = []
  const started = []
  let mountedSkill
  let mountedConfigDirectory
  const finalMessage = '完成。\n<!-- agent-automation-result\n{"version":1,"outcome":"completed","summary":"已提交 PR。"}\n-->'
  const adapters = createAgentAdapters({
    runCommand: async (command, args, options) => {
      calls.push({ command, args, options })
      mountedConfigDirectory = options.env.OPENCODE_CONFIG_DIR
      mountedSkill = await readFile(path.join(
        mountedConfigDirectory, 'skills', 'github-issue-work', 'SKILL.md',
      ), 'utf8')
      const firstEvent = JSON.stringify({ type: 'step_start', sessionID: 'ses_change', part: { type: 'step-start' } })
      options.onStdout(`${firstEvent}\n`)
      assert.deepEqual(started, [{ sessionId: 'ses_change' }])
      return {
        stdout: [
          firstEvent,
          JSON.stringify({ type: 'text', sessionID: 'ses_change', part: { type: 'text', messageID: 'msg_final', text: finalMessage } }),
          JSON.stringify({ type: 'step_finish', sessionID: 'ses_change', part: { type: 'step-finish' } }),
        ].join('\n'),
        stderr: '',
      }
    },
  })

  const receipt = await runAgentWorker({
    config: { workers: { opencode: {
      adapter: 'opencode-cli', executable: 'F:\\agents\\opencode.exe', mode: 'change',
      model: 'opencode/deepseek-v4', variant: 'max',
    } } },
    workerId: 'opencode',
    invocation: {
      taskId: 'issue-repo-42-request', cwd: 'F:\\checkout', title: 'Issue 42',
      prompt: '/github-issue-work {"repository":"owner/repo","issueNumber":42}',
      requiredSkill: 'github-issue-work', timeoutMs: 90_000,
      onStarted: value => started.push(value),
    },
    adapters,
  })

  assert.equal(calls[0].command, 'F:\\agents\\opencode.exe')
  assert.deepEqual(calls[0].args.slice(0, 5), ['run', '--format', 'json', '--auto', '--model'])
  assert.equal(calls[0].args.includes('opencode/deepseek-v4'), true)
  assert.equal(calls[0].args.includes('max'), true)
  assert.equal(calls[0].options.cwd, 'F:\\checkout')
  assert.match(calls[0].options.input, /Use the github-issue-work skill/)
  assert.match(mountedSkill, /^---\nname: github-issue-work\n/)
  await assert.rejects(access(mountedConfigDirectory))
  assert.deepEqual(started, [{ sessionId: 'ses_change' }])
  assert.equal(receipt.sessionId, 'ses_change')
  assert.equal(receipt.outcome, 'completed')
  assert.equal(receipt.detail, '已提交 PR。')
  assert.equal(receipt.output, finalMessage)
})

test('the OpenCode CLI adapter isolates untrusted review work from credentials and writes', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-opencode-review-test-'))
  const checkout = path.join(root, 'checkout')
  await mkdir(checkout)
  const base = '1'.repeat(40)
  const head = '2'.repeat(40)
  let opencodeCall
  let reviewBundle
  let reviewConfig
  let mountedSkill
  const adapters = createAgentAdapters({
    runCommand: async (command, args, options) => {
      if (command === 'git.exe') {
        if (args.includes('diff')) return { stdout: 'diff --git a/src/a.js b/src/a.js\n+new behavior\n', stderr: '' }
        if (args.includes('ls-tree')) return { stdout: 'AGENTS.md\nsrc/AGENTS.md\nsrc/a.js\n', stderr: '' }
        if (args.includes('show')) return { stdout: `trusted guidance for ${args.at(-1)}\n`, stderr: '' }
        throw new Error(`Unexpected git invocation: ${args.join(' ')}`)
      }
      opencodeCall = { command, args, options }
      reviewBundle = JSON.parse(await readFile(path.join(options.cwd, 'review-input.json'), 'utf8'))
      reviewConfig = JSON.parse(options.env.OPENCODE_CONFIG_CONTENT)
      mountedSkill = await readFile(path.join(
        options.env.OPENCODE_CONFIG_DIR, 'skills', 'github-pr-review', 'SKILL.md',
      ), 'utf8')
      return {
        stdout: JSON.stringify({
          type: 'text', sessionID: 'ses_review',
          part: { type: 'text', messageID: 'msg_review', text: 'VERDICT: PASS' },
        }),
        stderr: '',
      }
    },
  })
  try {
    const receipt = await runAgentWorker({
      config: { workers: { reviewer: {
        adapter: 'opencode-cli', executable: 'opencode.exe', gitExecutable: 'git.exe',
        mode: 'review', model: 'openai/gpt-5', variant: 'medium',
      } } },
      workerId: 'reviewer',
      invocation: {
        taskId: `review-${base}-${head}`, cwd: checkout, title: 'Review PR #42',
        prompt: 'Review this exact pull request pair.', requiredSkill: 'github-pr-review',
        timeoutMs: 60_000,
      },
      adapters,
    })

    assert.equal(opencodeCall.command, 'opencode.exe')
    assert.deepEqual(opencodeCall.args.slice(0, 2), ['--pure', 'run'])
    assert.notEqual(opencodeCall.options.cwd, checkout)
    assert.equal(opencodeCall.options.env.GH_TOKEN, undefined)
    assert.equal(opencodeCall.options.env.GITHUB_TOKEN, undefined)
    assert.equal(opencodeCall.options.env.DEEPSEEK_API_KEY, undefined)
    assert.equal(opencodeCall.options.env.OPENCODE_DISABLE_DEFAULT_PLUGINS, 'true')
    assert.equal(reviewConfig.agent['controller-review'].permission.edit, 'deny')
    assert.equal(reviewConfig.agent['controller-review'].permission.bash, 'deny')
    assert.equal(reviewConfig.agent['controller-review'].permission.external_directory['*'], 'deny')
    assert.equal(reviewConfig.agent['controller-review'].permission.external_directory[path.join(checkout, '**')], 'allow')
    assert.deepEqual(reviewBundle, {
      version: 1,
      base,
      head,
      diff: 'diff --git a/src/a.js b/src/a.js\n+new behavior\n',
      guidance: {
        'AGENTS.md': `trusted guidance for ${base}:AGENTS.md\n`,
        'src/AGENTS.md': `trusted guidance for ${base}:src/AGENTS.md\n`,
      },
    })
    assert.match(mountedSkill, /^---\nname: github-pr-review\n/)
    assert.equal(receipt.sessionId, 'ses_review')
    assert.equal(receipt.output, 'VERDICT: PASS')
    await assert.rejects(access(opencodeCall.options.cwd))
    await assert.rejects(access(opencodeCall.options.env.OPENCODE_CONFIG_DIR))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('OpenCode JSON output fails closed on malformed, failed, or mixed sessions', () => {
  assert.throws(() => parseOpenCodeRunOutput('not-json'), /not valid JSON/)
  assert.throws(() => parseOpenCodeRunOutput([
    JSON.stringify({ type: 'text', sessionID: 'one', part: { messageID: 'm1', text: 'one' } }),
    JSON.stringify({ type: 'text', sessionID: 'two', part: { messageID: 'm2', text: 'two' } }),
  ].join('\n')), /exactly one sessionID/)
  assert.throws(() => parseOpenCodeRunOutput([
    JSON.stringify({ type: 'error', sessionID: 'one', error: { name: 'ProviderError' } }),
  ].join('\n')), /session failed/)
})

test('the DSH Web adapter satisfies the same worker interface', async () => {
  const calls = []
  const started = []
  const adapters = createAgentAdapters({
    runDshSession: async input => {
      calls.push(input)
      await input.onCreated({ sessionId: 'dsh-visible' })
      return {
        sessionId: 'dsh-visible',
        reason: 'completed',
        finalMessage: '完成。\n<!-- agent-automation-result\n{"version":1,"outcome":"completed","summary":"完成"}\n-->',
        automationResult: { version: 1, outcome: 'completed', summary: '完成' },
      }
    },
  })
  const receipt = await runAgentWorker({
    config: { workers: { implementer: {
      adapter: 'dsh-web', baseUrl: 'http://localhost:3080', agentPreset: 'standard', permissionPreset: 'danger-full-access',
      provider: 'opencode-go', model: 'deepseek-v4-flash', reasoningEffort: 'max',
    } } },
    workerId: 'implementer',
    invocation: {
      taskId: 'issue-7', cwd: 'F:\\checkout', title: 'Issue 7',
      prompt: 'Implement issue 7.', timeoutMs: 120_000,
      requiredSkill: 'github-issue-work',
      onStarted: value => started.push(value),
    },
    adapters,
  })

  assert.equal(calls[0].baseUrl, 'http://localhost:3080')
  assert.equal(calls[0].taskId, 'issue-7')
  assert.deepEqual(calls[0].modelSelection, { provider: 'opencode-go', model: 'deepseek-v4-flash', reasoningEffort: 'max' })
  assert.equal(calls[0].agentPreset, 'standard')
  assert.equal(calls[0].permissionPreset, 'danger-full-access')
  assert.equal(calls[0].requiredSkill, 'github-issue-work')
  assert.deepEqual(started, [{ sessionId: 'dsh-visible' }])
  assert.equal(receipt.workerId, 'implementer')
  assert.equal(receipt.outcome, 'completed')
  assert.equal(receipt.detail, '完成')
  assert.equal(receipt.automationResult.outcome, 'completed')
})

test('the DSH Web adapter can perform review without a change-work receipt', async () => {
  const calls = []
  const adapters = createAgentAdapters({
    runDshSession: async input => {
      calls.push(input)
      return { sessionId: 'dsh-review', reason: 'completed', finalMessage: 'VERDICT: PASS' }
    },
  })
  const receipt = await runAgentWorker({
    config: { workers: { reviewer: {
      adapter: 'dsh-web', baseUrl: 'http://localhost:3080', agentPreset: 'standard', permissionPreset: 'read-only', provider: 'opencode-go',
      model: 'deepseek-v4-flash', reasoningEffort: 'max',
    } } },
    workerId: 'reviewer',
    invocation: {
      taskId: `review-${'1'.repeat(40)}-${'2'.repeat(40)}`,
      cwd: 'F:\\checkout', title: 'Review PR #42', prompt: 'Review it.',
      requiredSkill: 'github-pr-review', timeoutMs: 60_000,
    },
    adapters,
  })

  assert.equal(calls[0].requiresAutomationResult, false)
  assert.equal(receipt.outcome, 'completed')
  assert.equal(receipt.output, 'VERDICT: PASS')
  assert.equal(receipt.automationResult, undefined)
})

test('the Codex adapter satisfies the worker interface without GitHub credentials', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-agent-worker-'))
  const checkout = path.join(root, 'checkout')
  const home = path.join(root, 'codex-home')
  const project = path.join(root, 'project')
  await mkdir(checkout)
  const calls = []
  const adapters = createAgentAdapters({
    runCodexTask: async input => {
      calls.push(input)
      await input.onCreated({ sessionId: 'codex-thread' })
      return { threadId: 'codex-thread', finalMessage: 'PASS' }
    },
  })
  try {
    const receipt = await runAgentWorker({
      config: { workers: { reviewer: {
        adapter: 'codex-app', node: 'node.exe', script: 'codex.js',
        home,
        model: 'gpt-5.6-sol', effort: 'medium', keep: 6,
      } } },
      workerId: 'reviewer',
      invocation: {
        taskId: 'review-pair', cwd: checkout, projectCwd: project, title: 'Review pair',
        prompt: 'Review it.', timeoutMs: 60_000,
      },
      adapters,
    })

    assert.equal(calls[0].model, 'gpt-5.6-sol')
    assert.equal(calls[0].effort, 'medium')
    assert.equal(calls[0].projectCwd, project)
    assert.equal(calls[0].reviewCwd, checkout)
    assert.notEqual(calls[0].taskCwd, calls[0].reviewCwd)
    assert.equal(calls[0].taskCwd.startsWith(path.join(root, 'codex-review-context-')), true)
    assert.equal(calls[0].environment.GITHUB_TOKEN, undefined)
    assert.equal(calls[0].environment.GH_TOKEN, undefined)
    assert.equal(calls[0].environment.DEEPSEEK_API_KEY, undefined)
    assert.equal(calls[0].environment.GH_CONFIG_DIR, path.join(home, '.dsh-agent-automation', 'reviewer-gh'))
    assert.equal(calls[0].environment.GIT_CONFIG_GLOBAL, process.platform === 'win32' ? 'NUL' : '/dev/null')
    assert.equal(receipt.sessionId, 'codex-thread')
    assert.equal(receipt.output, 'PASS')
    assert.deepEqual(receipt.worker, {
      id: 'reviewer', adapter: 'codex-app', model: 'gpt-5.6-sol', reasoning: 'medium',
      displayName: 'codex-app gpt-5.6-sol (medium)',
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('worker receipts fail closed unless they end at a declared terminal outcome', async () => {
  await assert.rejects(runAgentWorker({
    config: { workers: { reviewer: { adapter: 'fake' } } },
    workerId: 'reviewer',
    invocation: {
      taskId: 'review-pair', cwd: 'F:\\checkout', title: 'Review pair',
      prompt: 'Review it.', timeoutMs: 60_000,
    },
    adapters: {
      fake: async () => ({ sessionId: 'thread', outcome: 'still-running' }),
    },
  }), /Unknown worker receipt outcome/)
})

test('worker health is adapter-specific and makes no task invocation', async () => {
  const calls = []
  const result = await checkAgentWorker({
    config: { workers: { reviewer: { adapter: 'fake' } } },
    workerId: 'reviewer',
    adapters: {
      fake: {
        run: async () => { throw new Error('must not run') },
        health: async input => {
          calls.push(input)
          return { detail: 'ready' }
        },
      },
    },
  })
  assert.equal(calls[0].workerId, 'reviewer')
  assert.deepEqual(result, { workerId: 'reviewer', detail: 'ready' })
})

test('a worker passes controller cancellation through its adapter invocation', async () => {
  const controller = new AbortController()
  let received
  await runAgentWorker({
    config: { workers: { dsh: { adapter: 'fake' } } }, workerId: 'dsh',
    invocation: { taskId: 'cancel', cwd: 'F:\\checkout', title: 'Cancel', prompt: 'Stop.', timeoutMs: 1, signal: controller.signal },
    adapters: { fake: async ({ invocation }) => {
      received = invocation.signal
      return { sessionId: 'session', outcome: 'failed' }
    } },
  })
  assert.equal(received, controller.signal)
})
