import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createWorkerExecutionClaim, runRoleWorker } from '../src/role-worker.mjs'
import { AGENT_ISSUE_SKILL, AGENT_MAINTENANCE_SKILL, parseAgentAutomationResult } from '../src/agent-work-result.mjs'
import { classifyAndCreateWorkerRouteDecision, createLocalWorkerRoutingExecution } from '../src/worker-routing.mjs'
import { capacityRecordKey, createCapacityRegistry } from '../src/capacity-registry-store.mjs'
import { recoverableRepairIdentity } from '../src/repair-state.mjs'

const stateVersion = 'a'.repeat(64)

function config() {
  return {
    operations: {
      roles: {
        change: { workers: ['first', 'second', 'third'] },
        review: { workers: ['first', 'second', 'third'] },
      },
      routing: {
        change: {
          maxCandidates: 8,
          routes: { default: { selectors: [{ worker: 'first' }, { worker: 'second' }, { worker: 'third' }] } },
        },
        review: {
          maxCandidates: 8,
          routes: { default: { selectors: [{ worker: 'first' }, { worker: 'second' }, { worker: 'third' }] } },
        },
      },
    },
    workers: {
      first: { adapter: 'fake', capacityGroup: 'first-group', capabilities: { hardReadOnlyReview: true } },
      second: { adapter: 'fake', capacityGroup: 'second-group', capabilities: { hardReadOnlyReview: true } },
      third: { adapter: 'fake', capacityGroup: 'third-group', capabilities: { hardReadOnlyReview: true } },
    },
  }
}

function invocation() {
  return { taskId: 'work-1', cwd: 'C:/checkout', title: 'Work', prompt: 'Do work.', timeoutMs: 1_000 }
}

function multiScopeConfig(stateRoot) {
  const value = config()
  value.operations.stateRoot = stateRoot
  value.configurationHash = 'c'.repeat(64)
  value.credentialGeneration = 'credential-1'
  value.workers.first.provider = 'provider-1'
  value.workers.first.model = 'model-1'
  return value
}

function scopedFailure(scope) {
  const reason = scope === 'model' ? 'model-unavailable' : scope === 'provider' ? 'provider-unavailable' : 'quota-exhausted'
  return {
    version: 1,
    category: 'capacity',
    reason,
    scope,
    phase: 'pre-session',
    code: `capacity.${scope}`,
    confidence: 'authoritative',
  }
}

async function seedExpiredScopes(registry, group = 'first-group', now = Date.parse('2026-08-21T00:00:00.000Z')) {
  await registry.recordFailure({
    capacityGroup: group,
    sourceWorker: 'first',
    failure: { ...scopedFailure('capacity-group'), reason: 'rate-limited', code: 'capacity.initial-group' },
    now,
    cooldownMs: 1,
  })
  await registry.recordFailure({ capacityGroup: group, sourceWorker: 'first', failure: scopedFailure('worker'), now, cooldownMs: 1 })
}

function scopedKeys(group = 'first-group') {
  const identity = { provider: 'provider-1', model: 'model-1', worker: 'first' }
  return {
    group: capacityRecordKey({ capacityGroup: group, scope: 'capacity-group', identity }),
    worker: capacityRecordKey({ capacityGroup: group, scope: 'worker', identity }),
  }
}

test('execution admission requires an atomic durable claim provider', () => {
  assert.throws(() => createWorkerExecutionClaim({
    config: config(),
    role: 'change',
    workRequest: { requestId: 'request-no-provider', role: 'change' },
    subjectStateVersion: stateVersion,
  }), /claimAttempt/)
  assert.throws(() => createWorkerExecutionClaim({
    config: config(),
    role: 'change',
    workRequest: { requestId: 'request-append-only', role: 'change' },
    subjectStateVersion: stateVersion,
    capacityProvider: { appendAttempt: async () => undefined },
  }), /claimAttempt/)
  assert.throws(() => createWorkerExecutionClaim({
    config: config(),
    role: 'change',
    workRequest: { requestId: 'request-caller-generation', role: 'change' },
    subjectStateVersion: stateVersion,
    generation: 1,
    capacityProvider: attemptProvider(),
  }), /provider-owned/)
})

function quotaError() {
  const error = new Error('quota exhausted')
  error.adapterFailure = {
    version: 1,
    category: 'capacity',
    reason: 'quota-exhausted',
    scope: 'capacity-group',
    phase: 'pre-session',
    code: 'provider.usage-limit',
    confidence: 'authoritative',
  }
  return error
}

test('runRoleWorker attempts each candidate once in resolved order', async () => {
  const calls = []
  const provider = attemptProvider()
  const result = await runRoleWorker({
    executionClaim: createWorkerExecutionClaim({
      config: config(), role: 'change', workRequest: { requestId: 'request-1', role: 'change' },
      subjectStateVersion: stateVersion, capacityProvider: provider,
    }),
    invocation: invocation(),
    adapters: {
      fake: async ({ workerId }) => {
        calls.push(workerId)
        if (workerId !== 'third') throw quotaError()
        return { sessionId: 'session-third', outcome: 'completed' }
      },
    },
  })

  assert.equal(result.workerId, 'third')
  assert.deepEqual(calls, ['first', 'second', 'third'])
})

test('local routing rejects a wrong or stale WorkerRouteDecision', async () => {
  const workRequest = { requestId: 'request-2', role: 'change' }
  const decision = classifyAndCreateWorkerRouteDecision({
    workRequest,
    subjectStateVersion: stateVersion,
    routingPolicy: config().operations.routing.change,
  })
  assert.throws(() => createLocalWorkerRoutingExecution({
    workRequest: { requestId: 'other-request', role: 'change' },
    subjectStateVersion: stateVersion,
    routingPolicy: config().operations.routing.change,
    routeDecision: decision,
  }), /does not match the WorkRequest/)
  assert.throws(() => createLocalWorkerRoutingExecution({
    workRequest,
    subjectStateVersion: 'b'.repeat(64),
    routingPolicy: config().operations.routing.change,
    routeDecision: decision,
  }), /does not match the subject/)
  assert.throws(() => createLocalWorkerRoutingExecution({
    workRequest,
    subjectStateVersion: stateVersion,
    routingPolicy: config().operations.routing.change,
    generation: 1,
  }), /provider-owned/)
})

test('local routing binds repair evidence to exact paths without a durable caller bypass', () => {
  const workRequest = { requestId: 'request-durable-route', role: 'change' }
  const routingPolicy = {
    version: 1,
    default: 'default',
    classificationOrder: ['frontend'],
    routes: {
      frontend: { rules: { pathPrefixes: ['web/'] } },
      default: { rules: {} },
    },
  }
  const routeDecision = classifyAndCreateWorkerRouteDecision({
    workRequest,
    subjectStateVersion: stateVersion,
    routingPolicy,
    trustedTaskSnapshot: { paths: ['web/Button.tsx'], workflowStage: 'repair' },
  })
  const execution = createLocalWorkerRoutingExecution({
    workRequest,
    subjectStateVersion: stateVersion,
    routingPolicy,
    trustedTaskSnapshot: { paths: ['web/Button.tsx'], workflowStage: 'repair' },
    routeDecision,
  })

  assert.deepEqual(execution.routeDecision, routeDecision)
})

function attemptProvider({ available = true, generation = 1, replayOutcome = null } = {}) {
  let currentGeneration = generation
  let currentAvailability = available
  const claims = new Map()
  const records = []
  const failures = []
  return {
    claims,
    records,
    failures,
    setGeneration(value) {
      currentGeneration = value
    },
    setAvailable(value) {
      currentAvailability = value
    },
    async inspect({ capacityGroup }) {
      return { eligible: currentAvailability, state: currentAvailability ? 'available' : 'disabled', generation: currentGeneration, capacityGroup }
    },
    async recordFailure(input) {
      failures.push(input)
    },
    async claimAttempt(input) {
      if (replayOutcome) {
        return { claimed: false, attempt: { ...input, result: { outcome: replayOutcome, category: null, reason: null } } }
      }
      const existing = claims.get(input.attemptId)
      if (existing) return { claimed: false, attempt: existing }
      claims.set(input.attemptId, input)
      return { claimed: true, attempt: input }
    },
    async appendAttempt(input) {
      records.push(input)
      if (input.attemptId.endsWith('-result')) {
        const baseAttemptId = input.attemptId.slice(0, -'-result'.length)
        const existing = claims.get(baseAttemptId)
        if (existing) claims.set(baseAttemptId, { ...existing, endedAt: input.endedAt, result: input.result })
      }
      return input
    },
  }
}

test('same trusted claim replays without executing and a provider generation executes', async () => {
  const provider = attemptProvider()
  const calls = []
  const input = {
    executionClaim: createWorkerExecutionClaim({
      config: config(), role: 'change', workRequest: { requestId: 'request-replay', role: 'change' },
      subjectStateVersion: stateVersion, capacityProvider: provider,
    }),
    invocation: invocation(),
    adapters: { fake: async ({ workerId }) => {
      calls.push(workerId)
      return { sessionId: `session-${calls.length}`, outcome: 'completed' }
    } },
  }
  const first = await runRoleWorker(input)
  const replay = await runRoleWorker(input)
  provider.setGeneration(2)
  const nextGeneration = await runRoleWorker({
    ...input,
    executionClaim: createWorkerExecutionClaim({
      config: config(), role: 'change', workRequest: { requestId: 'request-replay', role: 'change' },
      subjectStateVersion: stateVersion, capacityProvider: provider,
    }),
  })

  assert.equal(first.outcome, 'completed')
  assert.equal(replay.outcome, 'replayed')
  assert.equal(replay.priorOutcome, 'completed')
  assert.equal(nextGeneration.outcome, 'completed')
  assert.deepEqual(calls, ['first', 'first'])
  assert.equal(provider.claims.size, 2)
})

test('the local capacity registry durably claims and replays one execution claim', async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'dsh-role-worker-'))
  try {
    const localConfig = config()
    localConfig.operations.stateRoot = stateRoot
    localConfig.configurationHash = 'c'.repeat(64)
    localConfig.credentialGeneration = 'credential-1'
    let calls = 0
    const input = {
      executionClaim: createWorkerExecutionClaim({
        config: localConfig, role: 'change', workRequest: { requestId: 'request-durable-replay', role: 'change' },
        subjectStateVersion: stateVersion,
      }),
      invocation: invocation(),
      adapters: { fake: async () => {
        calls += 1
        return { sessionId: `session-${calls}`, outcome: 'completed' }
      } },
    }
    const first = await runRoleWorker(input)
    const replay = await runRoleWorker(input)

    assert.equal(first.outcome, 'completed')
    assert.equal(replay.outcome, 'replayed')
    assert.equal(replay.priorOutcome, 'completed')
    assert.equal(calls, 1)
  } finally {
    await rm(stateRoot, { recursive: true, force: true })
  }
})

test('a successful half-open probe replays the same output after the registry generation advances', async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'dsh-role-worker-probe-replay-'))
  try {
    let now = Date.parse('2026-08-21T00:00:00.000Z')
    const localConfig = multiScopeConfig(stateRoot)
    localConfig.operations.routing.change.routes.default.selectors = [{ worker: 'first' }]
    const registry = createCapacityRegistry({
      stateRoot,
      configurationHash: localConfig.configurationHash,
      credentialGeneration: localConfig.credentialGeneration,
      workers: localConfig.workers,
      now: () => now,
    })
    await registry.recordFailure({
      capacityGroup: 'first-group', sourceWorker: 'first', failure: scopedFailure('capacity-group'), now, cooldownMs: 1,
    })
    now += 2
    let calls = 0
    const run = () => runRoleWorker({
      executionClaim: createWorkerExecutionClaim({
        config: localConfig, role: 'change', workRequest: { requestId: 'request-probe-replay', role: 'change' },
        subjectStateVersion: stateVersion, capacityProvider: registry,
      }),
      invocation: invocation(),
      adapters: { fake: async () => {
        calls += 1
        return { sessionId: `review-${calls}`, outcome: 'completed', output: 'review-1' }
      } },
    })

    const first = await run()
    const second = await run()

    assert.equal(first.outcome, 'completed')
    assert.equal(first.output, 'review-1')
    assert.equal(second.outcome, 'replayed')
    assert.equal(second.priorOutcome, 'completed')
    assert.equal(second.output, 'review-1')
    assert.equal(calls, 1)
    const records = await registry.records()
    const groupKey = capacityRecordKey({ capacityGroup: 'first-group', scope: 'capacity-group' })
    assert.equal(records[groupKey].state, 'available')
    assert.ok(records[groupKey].generation > 1)
    assert.equal((await registry.attempts()).length, 2)
  } finally {
    await rm(stateRoot, { recursive: true, force: true })
  }
})

for (const failurePhase of ['before', 'after']) {
  test(`a ${failurePhase}-commit capacity projection failure replays the durable Worker result`, async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), `dsh-role-worker-projection-${failurePhase}-`))
    try {
      let now = Date.parse('2026-08-21T00:00:00.000Z')
      const localConfig = multiScopeConfig(stateRoot)
      localConfig.operations.routing.change.routes.default.selectors = [{ worker: 'first' }]
      const registry = createCapacityRegistry({
        stateRoot,
        configurationHash: localConfig.configurationHash,
        credentialGeneration: localConfig.credentialGeneration,
        workers: localConfig.workers,
        now: () => now,
      })
      await registry.recordFailure({
        capacityGroup: 'first-group', sourceWorker: 'first', failure: scopedFailure('capacity-group'), now, cooldownMs: 1,
      })
      now += 2
      const completeHalfOpenProbe = registry.completeHalfOpenProbe
      let projectionCalls = 0
      registry.completeHalfOpenProbe = async input => {
        projectionCalls += 1
        if (failurePhase === 'before') throw new Error(`capacity projection failed ${failurePhase}`)
        await completeHalfOpenProbe(input)
        throw new Error(`capacity projection failed ${failurePhase}`)
      }
      let adapterCalls = 0
      const run = () => runRoleWorker({
        executionClaim: createWorkerExecutionClaim({
          config: localConfig, role: 'change', workRequest: { requestId: `projection-${failurePhase}`, role: 'change' },
          subjectStateVersion: stateVersion, capacityProvider: registry,
        }),
        invocation: invocation(),
        adapters: { fake: async () => {
          adapterCalls += 1
          return { sessionId: 'completed-session', outcome: 'completed', output: 'durable-output' }
        } },
      })

      await assert.rejects(run(), new RegExp(`capacity projection failed ${failurePhase}`))
      const replay = await run()

      assert.equal(replay.outcome, 'replayed')
      assert.equal(replay.priorOutcome, 'completed')
      assert.equal(replay.output, 'durable-output')
      assert.equal(adapterCalls, 1)
      assert.equal(projectionCalls, 1)
    } finally {
      await rm(stateRoot, { recursive: true, force: true })
    }
  })
}

test('forged execution values are rejected before an adapter starts', async () => {
  let calls = 0
  for (const executionClaim of [1, {}, { generation: 2 }]) {
    await assert.rejects(runRoleWorker({
      executionClaim,
      invocation: invocation(),
      adapters: { fake: async () => { calls += 1; return { sessionId: 'unexpected', outcome: 'completed' } } },
    }), /opaque Worker execution claim/)
  }
  assert.equal(calls, 0)
})

test('same trusted claim replays without executing and a provider generation executes', async () => {
  const provider = attemptProvider({ generation: 1 })
  const calls = []
  const input = {
    executionClaim: createWorkerExecutionClaim({
      config: config(), role: 'change', workRequest: { requestId: 'request-capacity-generation', role: 'change' },
      subjectStateVersion: stateVersion, capacityProvider: provider,
    }),
    invocation: invocation(),
    adapters: { fake: async ({ workerId }) => {
      calls.push(workerId)
      return { sessionId: `session-${calls.length}`, outcome: 'completed' }
    } },
  }
  await runRoleWorker(input)
  provider.setGeneration(2)
  const next = await runRoleWorker({
    ...input,
    executionClaim: createWorkerExecutionClaim({
      config: config(), role: 'change', workRequest: { requestId: 'request-capacity-generation', role: 'change' },
      subjectStateVersion: stateVersion, capacityProvider: provider,
    }),
  })

  assert.equal(next.outcome, 'completed')
  assert.deepEqual(calls, ['first', 'first'])
  assert.equal(provider.claims.size, 2)
})

test('configuration and Worker identity rotation creates a distinct attempt', async () => {
  const provider = attemptProvider()
  const firstConfig = config()
  firstConfig.configurationHash = 'c'.repeat(64)
  firstConfig.credentialGeneration = 'credential-1'
  firstConfig.workers.first.provider = 'provider-1'
  firstConfig.workers.first.model = 'model-1'
  const run = (localConfig) => runRoleWorker({
    executionClaim: createWorkerExecutionClaim({
      config: localConfig, role: 'change', workRequest: { requestId: 'request-identity-rotation', role: 'change' },
      subjectStateVersion: stateVersion, capacityProvider: provider,
    }),
    invocation: invocation(),
    adapters: { fake: async ({ workerId }) => ({ sessionId: `session-${workerId}`, outcome: 'completed' }) },
  })

  await run(firstConfig)
  const rotatedConfig = structuredClone(firstConfig)
  rotatedConfig.configurationHash = 'd'.repeat(64)
  rotatedConfig.credentialGeneration = 'credential-2'
  rotatedConfig.workers.first.provider = 'provider-2'
  rotatedConfig.workers.first.model = 'model-2'
  const rotated = await run(rotatedConfig)

  assert.equal(rotated.outcome, 'completed')
  assert.equal(provider.claims.size, 2)
})

test('a pre-session capacity failure continues once to the next candidate', async () => {
  const provider = attemptProvider()
  const calls = []
  const result = await runRoleWorker({
    executionClaim: createWorkerExecutionClaim({
      config: config(), role: 'change', workRequest: { requestId: 'request-pre-session', role: 'change' },
      subjectStateVersion: stateVersion, capacityProvider: provider,
    }),
    invocation: invocation(),
    adapters: { fake: async ({ workerId }) => {
      calls.push(workerId)
      if (workerId === 'first') throw quotaError()
      return { sessionId: 'session-second', outcome: 'completed' }
    } },
  })

  assert.equal(result.workerId, 'second')
  assert.deepEqual(calls, ['first', 'second'])
})

test('capacity-deferred receipt hashes the post-failure capacity generation', async () => {
  const provider = attemptProvider({ available: true, generation: 3 })
  const inspect = provider.inspect
  provider.inspect = async input => {
    const value = await inspect(input)
    return {
      ...value,
      capacityGenerationHash: value.generation === 3 ? 'a'.repeat(64) : 'b'.repeat(64),
    }
  }
  const recordFailure = provider.recordFailure
  provider.recordFailure = async input => {
    await recordFailure(input)
    provider.setGeneration(4)
    provider.setAvailable(false)
  }
  const localConfig = config()
  localConfig.operations.routing.change.routes.default.selectors = [{ worker: 'first' }]

  const result = await runRoleWorker({
    executionClaim: createWorkerExecutionClaim({
      config: localConfig, role: 'change', workRequest: { requestId: 'request-post-failure', role: 'change' },
      subjectStateVersion: stateVersion, capacityProvider: provider,
    }),
    invocation: invocation(),
    adapters: { fake: async () => { throw quotaError() } },
  })

  const expected = createHash('sha256').update(JSON.stringify([{
    generation: 4, generationHash: 'b'.repeat(64), state: 'disabled',
  }])).digest('hex')
  assert.equal(result.outcome, 'capacity-deferred')
  assert.equal(result.capacityGenerationHash, expected)
  assert.equal(provider.failures.length, 1)
})

test('capacity-deferred fails closed when the post-failure snapshot is unavailable', async () => {
  const provider = attemptProvider({ available: true, generation: 3 })
  const inspect = provider.inspect
  const recordFailure = provider.recordFailure
  provider.recordFailure = async input => {
    await recordFailure(input)
    provider.inspect = async () => { throw new Error('post-failure snapshot unavailable') }
  }
  const localConfig = config()
  localConfig.operations.routing.change.routes.default.selectors = [{ worker: 'first' }]

  await assert.rejects(runRoleWorker({
    executionClaim: createWorkerExecutionClaim({
      config: localConfig, role: 'change', workRequest: { requestId: 'request-missing-post-snapshot', role: 'change' },
      subjectStateVersion: stateVersion, capacityProvider: provider,
    }),
    invocation: invocation(),
    adapters: { fake: async () => { throw quotaError() } },
  }), /post-failure snapshot unavailable/)
  provider.inspect = inspect
})

test('a quota failure after onStarted returns the original failure without failover', async () => {
  const provider = attemptProvider()
  const calls = []
  let started = 0
  await assert.rejects(runRoleWorker({
    executionClaim: createWorkerExecutionClaim({
      config: config(), role: 'change', workRequest: { requestId: 'request-started-quota', role: 'change' },
      subjectStateVersion: stateVersion, capacityProvider: provider,
    }),
    invocation: { ...invocation(), onStarted: () => { started += 1 } },
    adapters: { fake: async ({ workerId, invocation: adapterInvocation }) => {
      calls.push(workerId)
      await adapterInvocation.onStarted({ sessionId: 'started' })
      throw quotaError()
    } },
  }), /quota exhausted/)

  assert.deepEqual(calls, ['first'])
  assert.equal(started, 1)
})

test('only verified capacity failures continue to the next candidate', async () => {
  const nonCapacityFailures = [
    ['authentication', 'authentication-invalid', 'worker'],
    ['billing', 'billing-disabled', 'capacity-group'],
    ['transport', 'transport-failure', 'request'],
    ['task', 'task-failure', 'worker'],
  ]
  for (const [category, reason, scope] of nonCapacityFailures) {
    const calls = []
    const provider = attemptProvider()
    await assert.rejects(runRoleWorker({
      executionClaim: createWorkerExecutionClaim({
        config: config(), role: 'change', workRequest: { requestId: `failure-${reason}`, role: 'change' },
        subjectStateVersion: stateVersion, capacityProvider: provider,
      }),
      invocation: invocation(),
      adapters: { fake: async ({ workerId }) => {
        calls.push(workerId)
        const error = new Error(reason)
        error.adapterFailure = {
          version: 1, category, reason, scope, phase: 'pre-session', code: `${category}.failure`, confidence: 'authoritative',
        }
        throw error
      } },
    }), new RegExp(reason))
    assert.deepEqual(calls, ['first'])
    assert.equal(provider.failures.length, 0)
  }
})

test('all unavailable candidates return capacity-deferred without invoking a Worker', async () => {
  const provider = attemptProvider({ available: false, generation: 3 })
  let calls = 0
  let committed = 0
  const result = await runRoleWorker({
    executionClaim: createWorkerExecutionClaim({
      config: config(), role: 'change', workRequest: { requestId: 'request-deferred', role: 'change' },
      subjectStateVersion: stateVersion, capacityProvider: provider,
    }),
    onExecutionCommitted: async () => { committed += 1 },
    invocation: invocation(),
    adapters: { fake: async () => { calls += 1; return { sessionId: 'unexpected', outcome: 'completed' } } },
  })

  assert.equal(result.outcome, 'capacity-deferred')
  assert.equal(result.reason, 'capacity-deferred')
  assert.deepEqual(result.unavailable, ['first', 'second', 'third'])
  assert.equal(calls, 0)
  assert.equal(committed, 0)
  assert.equal(provider.claims.size, 3)
  assert.equal(provider.records.filter(item => item.result.outcome === 'capacity-deferred').length, 3)
  assert.equal(result.routeDecision.workRequestId, 'request-deferred')
  assert.equal(result.routeDecision.role, 'change')
  assert.match(result.capacityGenerationHash, /^[a-f0-9]{64}$/)
  assert.match(result.observationId, /^capacity-deferred-local-/)
  assert.doesNotMatch(JSON.stringify(result), /provider|model|account|credential/i)

  const laterGeneration = await runRoleWorker({
    executionClaim: createWorkerExecutionClaim({
      config: config(), role: 'change', workRequest: { requestId: 'request-deferred', role: 'change' },
      subjectStateVersion: stateVersion, capacityProvider: attemptProvider({ available: false, generation: 4 }),
    }),
    invocation: invocation(),
    adapters: { fake: async () => assert.fail('capacity-deferred must not start a Worker') },
  })
  assert.notEqual(laterGeneration.capacityGenerationHash, result.capacityGenerationHash)
})

test('recovery source identity reaches the original terminal journal and fills its missing commit once', async () => {
  const head = 'd'.repeat(40)
  const sourceRun = 31775196648
  const sourceComments = [{
    user: { login: 'controller' },
    body: [
      `<!-- dsh-review-repair:${'e'.repeat(40)}:${head}:ci-run-81-2 -->`,
      '- Status: **failed**',
      `- Controller SHA: \`${'e'.repeat(40)}\``,
      '- Repair class: `automatic-ci`',
      '- CI workflow: `CI`',
      `- Reviewed head: \`${head}\``,
      `- Run: https://github.com/Ornn8/deepseek-harness/actions/runs/${sourceRun}`,
    ].join('\n'),
  }]
  const identity = recoverableRepairIdentity({
    requestId: `recovery-${sourceRun}-1`,
    comments: sourceComments,
    controllerSha: 'e'.repeat(40),
    expectedHead: head,
    markerAuthor: 'controller',
    repository: 'Ornn8/deepseek-harness',
  })
  for (const outcome of ['completed', 'failed']) {
    const provider = attemptProvider()
    let calls = 0
    let commits = 0
    const request = { requestId: identity.originalRequestId, role: 'change' }
    const firstClaim = createWorkerExecutionClaim({
      config: config(), role: 'change', workRequest: request,
      subjectStateVersion: stateVersion, capacityProvider: provider,
    })
    const firstInput = {
      executionClaim: firstClaim,
      invocation: invocation(),
      adapters: { fake: async () => {
        calls += 1
        if (outcome === 'failed') {
          const error = new Error('durable task failure')
          error.adapterFailure = {
            version: 1, category: 'task', reason: 'task-failure', scope: 'worker',
            phase: 'session', code: 'worker.task-failure', confidence: 'authoritative',
          }
          throw error
        }
        return { sessionId: 'recovered-source', outcome: 'completed' }
      } },
    }
    if (outcome === 'failed') await assert.rejects(runRoleWorker(firstInput), /durable task failure/)
    else await runRoleWorker(firstInput)
    const replay = await runRoleWorker({
      executionClaim: createWorkerExecutionClaim({
        config: config(), role: 'change', workRequest: request,
        subjectStateVersion: stateVersion, capacityProvider: provider,
      }),
      invocation: invocation(),
      onExecutionCommitted: async () => { commits += 1 },
      adapters: { fake: async () => { throw new Error('recovery replay must not invoke Worker') } },
    })
    assert.equal(replay.outcome, 'replayed')
    assert.equal(replay.priorOutcome, outcome)
    assert.equal(calls, 1)
    assert.equal(commits, 1)
  }
})

test('capacity deferral leaves the execution commit hook untouched until same-claim reentry starts a Worker', async () => {
  const provider = attemptProvider({ available: false, generation: 3 })
  const starts = []
  let calls = 0
  const input = {
    executionClaim: createWorkerExecutionClaim({
      config: config(), role: 'change', workRequest: { requestId: 'request-deferred-reentry', role: 'change' },
      subjectStateVersion: stateVersion, capacityProvider: provider,
    }),
    onExecutionCommitted: async () => { starts.push('committed') },
    invocation: invocation(),
    adapters: { fake: async () => {
      calls += 1
      return { sessionId: 'reentry-session', outcome: 'completed' }
    } },
  }

  const deferred = await runRoleWorker(input)
  assert.equal(deferred.outcome, 'capacity-deferred')
  assert.deepEqual(starts, [])
  assert.equal(calls, 0)

  provider.setAvailable(true)
  provider.setGeneration(4)
  const resumed = await runRoleWorker(input)
  assert.equal(resumed.outcome, 'completed')
  assert.deepEqual(starts, ['committed'])
  assert.equal(calls, 1)
})

test('capacity fallback invokes the execution commit hook once after the successful adapter', async () => {
  const provider = attemptProvider()
  const calls = []
  const events = []
  const appendAttempt = provider.appendAttempt
  provider.appendAttempt = async input => {
    if (input.result.outcome !== 'claimed') events.push(`${input.result.outcome}:journal`)
    return appendAttempt(input)
  }
  const result = await runRoleWorker({
    executionClaim: createWorkerExecutionClaim({
      config: config(), role: 'change', workRequest: { requestId: 'request-start-order', role: 'change' },
      subjectStateVersion: stateVersion, capacityProvider: provider,
    }),
    onExecutionCommitted: async () => { events.push('execution-committed') },
    invocation: invocation(),
    adapters: { fake: async ({ workerId }) => {
      events.push(`${workerId}:adapter`)
      calls.push(workerId)
      if (workerId === 'first') throw quotaError()
      return { sessionId: 'second-session', outcome: 'completed' }
    } },
  })

  assert.equal(result.workerId, 'second')
  assert.deepEqual(calls, ['first', 'second'])
  assert.deepEqual(events, [
    'first:adapter', 'capacity-failure:journal',
    'second:adapter', 'completed:journal', 'execution-committed',
  ])
})

test('a completed replay with a missing execution commit invokes the hook without a Worker', async () => {
  const localConfig = config()
  localConfig.operations.routing.change.routes.default.selectors = [{ worker: 'first' }]
  const provider = attemptProvider({ generation: 1 })
  let starts = 0
  let calls = 0
  const input = {
    executionClaim: createWorkerExecutionClaim({
      config: localConfig, role: 'change', workRequest: { requestId: 'request-start-reentry', role: 'change' },
      subjectStateVersion: stateVersion, capacityProvider: provider,
    }),
    invocation: invocation(),
    adapters: { fake: async () => {
      calls += 1
      return { sessionId: 'completed-session', outcome: 'completed' }
    } },
  }

  assert.equal((await runRoleWorker(input)).outcome, 'completed')
  const replay = await runRoleWorker({
    ...input,
    onExecutionCommitted: async () => { starts += 1 },
    adapters: { fake: async () => { throw new Error('replay must not invoke Worker') } },
  })
  assert.equal(replay.outcome, 'replayed')
  assert.equal(replay.priorOutcome, 'completed')
  assert.equal(starts, 1)
  assert.equal(calls, 1)
})

test('a non-capacity failure commits once without replaying the Worker', async () => {
  const provider = attemptProvider()
  const calls = []
  let starts = 0
  const input = {
    executionClaim: createWorkerExecutionClaim({
      config: config(), role: 'change', workRequest: { requestId: 'request-non-capacity-commit', role: 'change' },
      subjectStateVersion: stateVersion, capacityProvider: provider,
    }),
    onExecutionCommitted: async () => { starts += 1 },
    invocation: invocation(),
    adapters: {
      fake: async ({ workerId }) => {
        calls.push(workerId)
        const error = new Error('task failed')
        error.adapterFailure = {
          version: 1, category: 'task', reason: 'task-failure', scope: 'worker', phase: 'session',
          code: 'worker.task-failure', confidence: 'authoritative',
        }
        throw error
      },
    },
  }
  await assert.rejects(runRoleWorker(input), /task failed/)
  const replay = await runRoleWorker(input)
  assert.equal(replay.outcome, 'replayed')
  assert.equal(replay.priorOutcome, 'failed')
  assert.equal(starts, 1)
  assert.deepEqual(calls, ['first'])
})

test('execution commit failure leaves the durable result for a later replay without rerunning the Worker', async () => {
  const provider = attemptProvider()
  let calls = 0
  let commitAttempts = 0
  const input = {
    executionClaim: createWorkerExecutionClaim({
      config: config(), role: 'review', workRequest: { requestId: 'request-commit-retry', role: 'review' },
      subjectStateVersion: stateVersion, capacityProvider: provider,
    }),
    invocation: invocation(),
    adapters: { fake: async () => {
      calls += 1
      return { sessionId: 'commit-retry-session', outcome: 'completed' }
    } },
    onExecutionCommitted: async () => {
      commitAttempts += 1
      if (commitAttempts === 1) throw new Error('started record write failed')
    },
  }

  await assert.rejects(runRoleWorker(input), /started record write failed/)
  const replay = await runRoleWorker(input)
  assert.equal(replay.outcome, 'replayed')
  assert.equal(replay.priorOutcome, 'completed')
  assert.equal(calls, 1)
  assert.equal(commitAttempts, 2)
})

test('completed replay for a non-receipt skill preserves durable output', async () => {
  const localConfig = config()
  localConfig.workers.first.capabilities.skills = [AGENT_MAINTENANCE_SKILL]
  const provider = attemptProvider()
  const input = {
    executionClaim: createWorkerExecutionClaim({
      config: localConfig, role: 'review', workRequest: { requestId: 'request-replay-output', role: 'review' },
      subjectStateVersion: stateVersion, capacityProvider: provider,
    }),
    invocation: { ...invocation(), requiredSkill: AGENT_MAINTENANCE_SKILL },
    adapters: { fake: async () => ({ sessionId: 'review-session', outcome: 'completed', output: 'machine review result' }) },
  }

  const first = await runRoleWorker(input)
  const replay = await runRoleWorker(input)

  assert.equal(first.outcome, 'completed')
  assert.equal(replay.outcome, 'replayed')
  assert.equal(replay.priorOutcome, 'completed')
  assert.equal(replay.output, 'machine review result')
  assert.equal(replay.automationResult, undefined)
})

test('distinct trusted review request ids cannot replay one completed review', async () => {
  const provider = attemptProvider()
  let calls = 0
  const runReview = requestId => runRoleWorker({
    executionClaim: createWorkerExecutionClaim({
      config: config(), role: 'review', workRequest: { requestId, role: 'review' },
      subjectStateVersion: stateVersion, capacityProvider: provider,
    }),
    invocation: invocation(),
    adapters: { fake: async () => {
      calls += 1
      return { sessionId: `review-${calls}`, outcome: 'completed', output: `review-${calls}` }
    } },
  })

  const first = await runReview('review-contract-v1')
  const rotated = await runReview('review-contract-v2')

  assert.equal(first.outcome, 'completed')
  assert.equal(rotated.outcome, 'completed')
  assert.equal(calls, 2)
})

test('completed replay rehydrates its parsed automation result without starting a Worker', async () => {
  const localConfig = config()
  localConfig.workers.first.capabilities.skills = [AGENT_ISSUE_SKILL]
  const provider = attemptProvider()
  const finalMessage = 'Done.\n<!-- agent-automation-result\n{"version":1,"outcome":"completed","summary":"Published the change."}\n-->'
  const automationResult = parseAgentAutomationResult(finalMessage)
  let calls = 0
  const input = {
    executionClaim: createWorkerExecutionClaim({
      config: localConfig, role: 'change', workRequest: { requestId: 'request-replay-result', role: 'change' },
      subjectStateVersion: stateVersion, capacityProvider: provider,
    }),
    invocation: { ...invocation(), requiredSkill: AGENT_ISSUE_SKILL },
    adapters: { fake: async () => {
      calls += 1
      return { sessionId: 'result-session', outcome: 'completed', output: finalMessage, automationResult }
    } },
  }

  const first = await runRoleWorker(input)
  const replay = await runRoleWorker({
    ...input,
    adapters: { fake: async () => { calls += 1; throw new Error('replay must not invoke Worker') } },
  })

  assert.deepEqual(replay.automationResult, first.automationResult)
  assert.equal(calls, 1)
})

test('malformed completed replay output fails closed before starting a Worker', async () => {
  const localConfig = config()
  localConfig.workers.first.capabilities.skills = [AGENT_ISSUE_SKILL]
  const provider = attemptProvider()
  let calls = 0
  const input = {
    executionClaim: createWorkerExecutionClaim({
      config: localConfig, role: 'change', workRequest: { requestId: 'request-malformed-replay-output', role: 'change' },
      subjectStateVersion: stateVersion, capacityProvider: provider,
    }),
    invocation: { ...invocation(), requiredSkill: AGENT_ISSUE_SKILL },
    adapters: { fake: async () => {
      calls += 1
      return { sessionId: 'malformed-session', outcome: 'completed', output: 'not an automation result' }
    } },
  }

  await runRoleWorker(input)
  await assert.rejects(runRoleWorker({
    ...input,
    adapters: { fake: async () => { calls += 1; throw new Error('replay must not invoke Worker') } },
  }), /must end with the automation result/)
  assert.equal(calls, 1)
})

test('all previously capacity-deferred candidates replay as deferred without starting a Worker', async () => {
  const provider = attemptProvider({ available: false, generation: 3 })
  let calls = 0
  const input = {
    executionClaim: createWorkerExecutionClaim({
      config: config(), role: 'change', workRequest: { requestId: 'request-deferred-replay', role: 'change' },
      subjectStateVersion: stateVersion, capacityProvider: provider,
    }),
    invocation: invocation(),
    adapters: { fake: async () => { calls += 1; return { sessionId: 'unexpected', outcome: 'completed' } } },
  }

  const first = await runRoleWorker(input)
  const replay = await runRoleWorker(input)

  assert.equal(first.outcome, 'capacity-deferred')
  assert.equal(replay.outcome, 'capacity-deferred')
  assert.deepEqual(replay.unavailable, ['first', 'second', 'third'])
  assert.equal(replay.capacityGenerationHash, first.capacityGenerationHash)
  assert.equal(replay.observationId, first.observationId)
  assert.deepEqual(replay.routeDecision, first.routeDecision)
  assert.equal(calls, 0)
  assert.equal(provider.records.filter(item => item.result.outcome === 'capacity-deferred').length, 3)
})

test('previous capacity-failure candidates are skipped before the next admitted Worker', async () => {
  const provider = attemptProvider({ replayOutcome: 'capacity-failure' })
  let calls = 0
  const result = await runRoleWorker({
    executionClaim: createWorkerExecutionClaim({
      config: config(), role: 'change', workRequest: { requestId: 'request-capacity-failure-replay', role: 'change' },
      subjectStateVersion: stateVersion, capacityProvider: provider,
    }),
    invocation: invocation(),
    adapters: { fake: async () => { calls += 1; return { sessionId: 'unexpected', outcome: 'completed' } } },
  })

  assert.equal(result.outcome, 'capacity-deferred')
  assert.deepEqual(result.unavailable, ['first', 'second', 'third'])
  assert.equal(calls, 0)
})

test('completed and claimed attempt replays remain terminal and never become neutral capacity deferrals', async () => {
  for (const priorOutcome of ['completed', 'claimed']) {
    const provider = attemptProvider({ replayOutcome: priorOutcome })
    let calls = 0
    let commits = 0
    const result = await runRoleWorker({
      executionClaim: createWorkerExecutionClaim({
        config: config(), role: 'review', workRequest: { requestId: `request-${priorOutcome}-replay`, role: 'review' },
        subjectStateVersion: stateVersion, capacityProvider: provider,
      }),
      onExecutionCommitted: async () => { commits += 1 },
      invocation: invocation(),
      adapters: { fake: async () => { calls += 1; return { sessionId: 'unexpected', outcome: 'completed' } } },
    })

    assert.equal(result.outcome, 'replayed')
    assert.equal(result.priorOutcome, priorOutcome)
    assert.equal(calls, 0)
    assert.equal(commits, priorOutcome === 'completed' ? 1 : 0)
  }
})

test('claim completion wire is parsed and immutable attempt conflicts are rejected', async () => {
  const malformed = attemptProvider({ replayOutcome: 'completed' })
  malformed.claimAttempt = async input => ({
    claimed: false,
    attempt: { ...input, result: { outcome: 'completed', category: null, reason: null, extra: true } },
  })
  await assert.rejects(runRoleWorker({
    executionClaim: createWorkerExecutionClaim({
      config: config(), role: 'review', workRequest: { requestId: 'request-malformed-replay', role: 'review' },
      subjectStateVersion: stateVersion, capacityProvider: malformed,
    }),
    invocation: invocation(),
    adapters: { fake: async () => ({ sessionId: 'unexpected', outcome: 'completed' }) },
  }), /unknown field extra/)

  const conflicting = attemptProvider({ replayOutcome: 'completed' })
  conflicting.claimAttempt = async input => ({
    claimed: false,
    attempt: { ...input, workerId: 'other', result: { outcome: 'completed', category: null, reason: null } },
  })
  await assert.rejects(runRoleWorker({
    executionClaim: createWorkerExecutionClaim({
      config: config(), role: 'review', workRequest: { requestId: 'request-conflicting-replay', role: 'review' },
      subjectStateVersion: stateVersion, capacityProvider: conflicting,
    }),
    invocation: invocation(),
    adapters: { fake: async () => ({ sessionId: 'unexpected', outcome: 'completed' }) },
  }), /conflicting attempt/)
})

test('real registry claims two expired scopes atomically and closes both on success', async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'dsh-role-worker-multiscope-'))
  try {
    let now = Date.parse('2026-08-21T00:00:00.000Z')
    const localConfig = multiScopeConfig(stateRoot)
    const registry = createCapacityRegistry({
      stateRoot,
      configurationHash: localConfig.configurationHash,
      credentialGeneration: localConfig.credentialGeneration,
      workers: localConfig.workers,
      now: () => now,
    })
    await seedExpiredScopes(registry, 'first-group', now)
    now += 2
    const calls = []
    const result = await runRoleWorker({
      executionClaim: createWorkerExecutionClaim({
        config: localConfig, role: 'change', workRequest: { requestId: 'multi-success', role: 'change' },
        subjectStateVersion: stateVersion, capacityProvider: registry,
      }),
      invocation: invocation(),
      adapters: { fake: async ({ workerId }) => { calls.push(workerId); return { sessionId: 'session-first', outcome: 'completed' } } },
    })
    const records = await registry.records()
    assert.equal(result.outcome, 'completed')
    assert.deepEqual(calls, ['first'])
    assert.equal(records[scopedKeys().group].state, 'available')
    assert.equal(records[scopedKeys().worker].state, 'available')
    assert.equal(records[scopedKeys().group].lease, null)
    assert.equal(records[scopedKeys().worker].lease, null)
  } finally {
    await rm(stateRoot, { recursive: true, force: true })
  }
})

test('concurrent executions share one multi-scope probe and one real invocation', async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'dsh-role-worker-concurrent-probe-'))
  try {
    let now = Date.parse('2026-08-21T00:00:00.000Z')
    const localConfig = multiScopeConfig(stateRoot)
    const registry = createCapacityRegistry({
      stateRoot,
      configurationHash: localConfig.configurationHash,
      credentialGeneration: localConfig.credentialGeneration,
      workers: localConfig.workers,
      now: () => now,
    })
    await seedExpiredScopes(registry, 'first-group', now)
    now += 2
    const claims = [1, 2].map(() => createWorkerExecutionClaim({
      config: localConfig, role: 'change', workRequest: { requestId: 'multi-concurrent', role: 'change' },
      subjectStateVersion: stateVersion, capacityProvider: registry,
    }))
    const calls = []
    const run = executionClaim => runRoleWorker({
      executionClaim,
      invocation: invocation(),
      adapters: { fake: async ({ workerId }) => {
        calls.push(workerId)
        await new Promise(resolve => setTimeout(resolve, 10))
        return { sessionId: 'session-first', outcome: 'completed' }
      } },
    })
    const results = await Promise.all(claims.map(run))
    assert.equal(results.filter(result => result.outcome === 'completed').length, 1)
    assert.equal(results.filter(result => result.outcome === 'replayed').length, 1)
    assert.deepEqual(calls, ['first'])
    const records = await registry.records()
    assert.equal(records[scopedKeys().group].lease, null)
    assert.equal(records[scopedKeys().worker].lease, null)
  } finally {
    await rm(stateRoot, { recursive: true, force: true })
  }
})

test('a blocked scope rolls back a multi-scope claim without publishing a partial lease', async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'dsh-role-worker-claim-rollback-'))
  try {
    let now = Date.parse('2026-08-21T00:00:00.000Z')
    const localConfig = multiScopeConfig(stateRoot)
    localConfig.operations.routing.change.routes.default.selectors = [{ worker: 'first' }]
    const registry = createCapacityRegistry({
      stateRoot,
      configurationHash: localConfig.configurationHash,
      credentialGeneration: localConfig.credentialGeneration,
      workers: localConfig.workers,
      now: () => now,
    })
    await registry.recordFailure({
      capacityGroup: 'first-group', sourceWorker: 'first', failure: { ...scopedFailure('capacity-group'), reason: 'rate-limited' }, now, cooldownMs: 1,
    })
    await registry.recordFailure({
      capacityGroup: 'first-group', sourceWorker: 'first', failure: scopedFailure('worker'), now, cooldownMs: 60_000,
    })
    now += 2
    let calls = 0
    const deferred = await runRoleWorker({
      executionClaim: createWorkerExecutionClaim({
        config: localConfig, role: 'change', workRequest: { requestId: 'claim-rollback', role: 'change' },
        subjectStateVersion: stateVersion, capacityProvider: registry,
      }),
      invocation: invocation(),
      adapters: { fake: async () => { calls += 1; return { sessionId: 'unexpected', outcome: 'completed' } } },
    })
    assert.equal(deferred.outcome, 'capacity-deferred')
    assert.equal(calls, 0)
    let records = await registry.records()
    assert.equal(records[scopedKeys().group].lease, null)
    assert.equal(records[scopedKeys().worker].lease, null)
    now += 60_000
    const recovered = await runRoleWorker({
      executionClaim: createWorkerExecutionClaim({
        config: localConfig, role: 'change', workRequest: { requestId: 'claim-rollback-retry', role: 'change' },
        subjectStateVersion: stateVersion, capacityProvider: registry,
      }),
      invocation: invocation(),
      adapters: { fake: async () => { calls += 1; return { sessionId: 'recovered', outcome: 'completed' } } },
    })
    assert.equal(recovered.outcome, 'completed')
    assert.equal(calls, 1)
    records = await registry.records()
    assert.equal(records[scopedKeys().group].lease, null)
    assert.equal(records[scopedKeys().worker].lease, null)
  } finally {
    await rm(stateRoot, { recursive: true, force: true })
  }
})

for (const matchingScope of ['capacity-group', 'worker']) {
  test(`structured ${matchingScope} failure updates only the matching scope and abandons the other`, async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), `dsh-role-worker-${matchingScope}-`))
    try {
      let now = Date.parse('2026-08-21T00:00:00.000Z')
      const localConfig = multiScopeConfig(stateRoot)
      const registry = createCapacityRegistry({
        stateRoot,
        configurationHash: localConfig.configurationHash,
        credentialGeneration: localConfig.credentialGeneration,
        workers: localConfig.workers,
        now: () => now,
      })
      await seedExpiredScopes(registry, 'first-group', now)
      now += 2
      const calls = []
      const result = await runRoleWorker({
        executionClaim: createWorkerExecutionClaim({
          config: localConfig, role: 'change', workRequest: { requestId: `multi-${matchingScope}`, role: 'change' },
          subjectStateVersion: stateVersion, capacityProvider: registry,
        }),
        invocation: invocation(),
        adapters: { fake: async ({ workerId }) => {
          calls.push(workerId)
          if (workerId === 'first') {
            const failure = matchingScope === 'worker'
              ? { ...scopedFailure('worker'), reason: 'model-unavailable', code: 'capacity.matching-worker' }
              : scopedFailure('capacity-group')
            throw Object.assign(new Error('capacity hit'), { adapterFailure: failure })
          }
          return { sessionId: 'session-second', outcome: 'completed' }
        } },
      })
      const records = await registry.records()
      assert.equal(result.workerId, 'second')
      assert.deepEqual(calls, ['first', 'second'])
      assert.equal(records[scopedKeys().group].state, 'cooldown')
      assert.equal(records[scopedKeys().worker].state, 'cooldown')
      assert.equal(records[scopedKeys().group].lease, null)
      assert.equal(records[scopedKeys().worker].lease, null)
      assert.equal(records[scopedKeys().group].reason, matchingScope === 'capacity-group' ? 'quota-exhausted' : 'rate-limited')
      assert.equal(records[scopedKeys().worker].reason, matchingScope === 'worker' ? 'model-unavailable' : 'quota-exhausted')
    } finally {
      await rm(stateRoot, { recursive: true, force: true })
    }
  })
}

test('adapter failure abandons every claimed scope without leaking a lease', async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'dsh-role-worker-abandon-'))
  try {
    let now = Date.parse('2026-08-21T00:00:00.000Z')
    const localConfig = multiScopeConfig(stateRoot)
    const registry = createCapacityRegistry({
      stateRoot,
      configurationHash: localConfig.configurationHash,
      credentialGeneration: localConfig.credentialGeneration,
      workers: localConfig.workers,
      now: () => now,
    })
    await seedExpiredScopes(registry, 'first-group', now)
    now += 2
    await assert.rejects(runRoleWorker({
      executionClaim: createWorkerExecutionClaim({
        config: localConfig, role: 'change', workRequest: { requestId: 'multi-abandon', role: 'change' },
        subjectStateVersion: stateVersion, capacityProvider: registry,
      }),
      invocation: invocation(),
      adapters: { fake: async () => { throw new Error('setup failed') } },
    }), /setup failed/)
    const records = await registry.records()
    assert.equal(records[scopedKeys().group].lease, null)
    assert.equal(records[scopedKeys().worker].lease, null)
  } finally {
    await rm(stateRoot, { recursive: true, force: true })
  }
})

test('an independent later generation can claim the scopes again after a deferred probe', async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'dsh-role-worker-independent-probe-'))
  try {
    let now = Date.parse('2026-08-21T00:00:00.000Z')
    const localConfig = multiScopeConfig(stateRoot)
    const registry = createCapacityRegistry({
      stateRoot,
      configurationHash: localConfig.configurationHash,
      credentialGeneration: localConfig.credentialGeneration,
      workers: localConfig.workers,
      now: () => now,
    })
    await seedExpiredScopes(registry, 'first-group', now)
    now += 2
    const calls = []
    const first = await runRoleWorker({
      executionClaim: createWorkerExecutionClaim({
        config: localConfig, role: 'change', workRequest: { requestId: 'multi-independent', role: 'change' },
        subjectStateVersion: stateVersion, capacityProvider: registry,
      }),
      invocation: invocation(),
      adapters: { fake: async ({ workerId }) => {
        calls.push(workerId)
        if (workerId === 'first') throw Object.assign(new Error('quota exhausted'), { adapterFailure: scopedFailure('capacity-group') })
        return { sessionId: 'session-second', outcome: 'completed' }
      } },
    })
    assert.equal(first.workerId, 'second')
    now += 61_000
    const second = await runRoleWorker({
      executionClaim: createWorkerExecutionClaim({
        config: localConfig, role: 'change', workRequest: { requestId: 'multi-independent', role: 'change' },
        subjectStateVersion: stateVersion, capacityProvider: registry,
      }),
      invocation: invocation(),
      adapters: { fake: async ({ workerId }) => {
        calls.push(workerId)
        return { sessionId: 'session-first-recovered', outcome: 'completed' }
      } },
    })
    assert.equal(second.outcome, 'completed')
    assert.deepEqual(calls, ['first', 'second', 'first'])
    const records = await registry.records()
    assert.equal(records[scopedKeys().group].lease, null)
    assert.equal(records[scopedKeys().worker].lease, null)
    assert.equal(records[scopedKeys().group].state, 'available')
    assert.equal(records[scopedKeys().worker].state, 'available')
  } finally {
    await rm(stateRoot, { recursive: true, force: true })
  }
})

test('a same-group Worker can claim and complete a group record created by another Worker', async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'dsh-role-worker-shared-group-'))
  try {
    let now = Date.parse('2026-08-21T00:00:00.000Z')
    const localConfig = multiScopeConfig(stateRoot)
    localConfig.workers.first.capacityGroup = 'shared-group'
    localConfig.workers.second.capacityGroup = 'shared-group'
    localConfig.operations.routing.change.routes.default.selectors = [{ worker: 'second' }]
    const registry = createCapacityRegistry({
      stateRoot,
      configurationHash: localConfig.configurationHash,
      credentialGeneration: localConfig.credentialGeneration,
      workers: localConfig.workers,
      now: () => now,
    })
    await registry.recordFailure({
      capacityGroup: 'shared-group', sourceWorker: 'first', failure: scopedFailure('capacity-group'), now, cooldownMs: 1,
    })
    now += 2
    const result = await runRoleWorker({
      executionClaim: createWorkerExecutionClaim({
        config: localConfig, role: 'change', workRequest: { requestId: 'shared-group-probe', role: 'change' },
        subjectStateVersion: stateVersion, capacityProvider: registry,
      }),
      invocation: invocation(),
      adapters: { fake: async () => ({ sessionId: 'second-session', outcome: 'completed' }) },
    })
    const records = await registry.records()
    const groupKey = capacityRecordKey({ capacityGroup: 'shared-group', scope: 'capacity-group' })
    assert.equal(result.workerId, 'second')
    assert.deepEqual(records[groupKey].capacityIdentity, { provider: null, model: null, worker: null })
    assert.equal(records[groupKey].state, 'available')
    assert.equal(records[groupKey].lease, null)
  } finally {
    await rm(stateRoot, { recursive: true, force: true })
  }
})

test('an expired one-millisecond probe lease is safely reclaimed by the next claimant', async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'dsh-role-worker-expired-probe-'))
  try {
    let now = Date.parse('2026-08-21T00:00:00.000Z')
    const localConfig = multiScopeConfig(stateRoot)
    const registry = createCapacityRegistry({
      stateRoot,
      configurationHash: localConfig.configurationHash,
      credentialGeneration: localConfig.credentialGeneration,
      workers: localConfig.workers,
      now: () => now,
    })
    await registry.recordFailure({
      capacityGroup: 'first-group', sourceWorker: 'first', failure: scopedFailure('capacity-group'), now, cooldownMs: 1,
    })
    now += 2
    const first = await registry.claimHalfOpenProbe({ workerId: 'first', leaseId: 'probe-expiring', owner: 'first', now, leaseMs: 1 })
    assert.ok(first.probe)
    now += 1
    assert.deepEqual((await registry.inspect({ workerId: 'first', now })).probeScopes, ['capacity-group'])
    const reclaimed = await registry.claimHalfOpenProbe({ workerId: 'first', leaseId: 'probe-reclaimed', owner: 'second', now, leaseMs: 1 })
    assert.ok(reclaimed.probe)
    await registry.completeHalfOpenProbe({ probe: reclaimed.probe, outcome: 'success', now })
    const key = capacityRecordKey({ capacityGroup: 'first-group', scope: 'capacity-group' })
    const record = (await registry.records())[key]
    assert.equal(record.state, 'available')
    assert.equal(record.lease, null)
  } finally {
    await rm(stateRoot, { recursive: true, force: true })
  }
})

for (const missingScope of ['model', 'provider']) {
  test(`a claimed group probe records an authoritative ${missingScope} failure in one transaction`, async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), `dsh-role-worker-missing-${missingScope}-`))
    try {
      let now = Date.parse('2026-08-21T00:00:00.000Z')
      const localConfig = multiScopeConfig(stateRoot)
      localConfig.operations.routing.change.routes.default.selectors = [{ worker: 'first' }]
      const registry = createCapacityRegistry({
        stateRoot,
        configurationHash: localConfig.configurationHash,
        credentialGeneration: localConfig.credentialGeneration,
        workers: localConfig.workers,
        now: () => now,
      })
      await registry.recordFailure({
        capacityGroup: 'first-group', sourceWorker: 'first', failure: scopedFailure('capacity-group'), now, cooldownMs: 1,
      })
      now += 2
      const deferred = await runRoleWorker({
        executionClaim: createWorkerExecutionClaim({
          config: localConfig, role: 'change', workRequest: { requestId: `missing-${missingScope}`, role: 'change' },
          subjectStateVersion: stateVersion, capacityProvider: registry,
        }),
        invocation: invocation(),
        adapters: { fake: async () => {
          throw Object.assign(new Error(`${missingScope} unavailable`), { adapterFailure: scopedFailure(missingScope) })
        } },
      })
      let records = await registry.records()
      const groupKey = capacityRecordKey({ capacityGroup: 'first-group', scope: 'capacity-group' })
      const scopedKey = capacityRecordKey({
        capacityGroup: 'first-group', scope: missingScope,
        identity: { provider: 'provider-1', model: 'model-1', worker: 'first' },
      })
      assert.equal(deferred.outcome, 'capacity-deferred')
      assert.equal(records[groupKey].lease, null)
      assert.equal(records[scopedKey].state, 'cooldown')
      assert.equal(records[scopedKey].reason, scopedFailure(missingScope).reason)
      now += 15 * 60 * 1000 + 1
      const recovered = await runRoleWorker({
        executionClaim: createWorkerExecutionClaim({
          config: localConfig, role: 'change', workRequest: { requestId: `missing-${missingScope}-retry`, role: 'change' },
          subjectStateVersion: stateVersion, capacityProvider: registry,
        }),
        invocation: invocation(),
        adapters: { fake: async () => ({ sessionId: 'recovered-session', outcome: 'completed' }) },
      })
      records = await registry.records()
      assert.equal(recovered.outcome, 'completed')
      assert.equal(records[groupKey].lease, null)
      assert.equal(records[scopedKey].lease, null)
      assert.equal(records[groupKey].state, 'available')
      assert.equal(records[scopedKey].state, 'available')
    } finally {
      await rm(stateRoot, { recursive: true, force: true })
    }
  })
}
