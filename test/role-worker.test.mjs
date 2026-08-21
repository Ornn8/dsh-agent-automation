import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createWorkerExecutionClaim, runRoleWorker } from '../src/role-worker.mjs'
import { classifyAndCreateWorkerRouteDecision, createLocalWorkerRoutingExecution } from '../src/worker-routing.mjs'

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

function attemptProvider({ available = true, generation = 1 } = {}) {
  let currentGeneration = generation
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
    async inspect({ capacityGroup }) {
      return { eligible: available, state: available ? 'available' : 'disabled', generation: currentGeneration, capacityGroup }
    },
    async recordFailure(input) {
      failures.push(input)
    },
    async claimAttempt(input) {
      const existing = claims.get(input.attemptId)
      if (existing) return { claimed: false, attempt: existing }
      claims.set(input.attemptId, input)
      return { claimed: true, attempt: input }
    },
    async appendAttempt(input) {
      records.push(input)
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
    assert.equal(calls, 1)
  } finally {
    await rm(stateRoot, { recursive: true, force: true })
  }
})

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

test('a changed provider generation creates a new attempt identity', async () => {
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
  const result = await runRoleWorker({
    executionClaim: createWorkerExecutionClaim({
      config: config(), role: 'change', workRequest: { requestId: 'request-deferred', role: 'change' },
      subjectStateVersion: stateVersion, capacityProvider: provider,
    }),
    invocation: invocation(),
    adapters: { fake: async () => { calls += 1; return { sessionId: 'unexpected', outcome: 'completed' } } },
  })

  assert.equal(result.outcome, 'capacity-deferred')
  assert.equal(result.reason, 'capacity-deferred')
  assert.deepEqual(result.unavailable, ['first', 'second', 'third'])
  assert.equal(calls, 0)
  assert.equal(provider.claims.size, 3)
  assert.equal(provider.records.filter(item => item.result.outcome === 'capacity-deferred').length, 3)
})
