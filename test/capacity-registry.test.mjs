import assert from 'node:assert/strict'
import test from 'node:test'
import {
  AdapterFailureError,
  adapterFailureFromError,
  annotateAdapterFailure,
  canFailoverCapacityFailure,
  disablesCapacity,
  parseAdapterFailure,
} from '../src/capacity-failure.mjs'
import {
  acquireHalfOpenLease,
  capacityEligibility,
  completeHalfOpenLease,
  createCapacityRecord,
  invalidateCapacityRecord,
  projectWorkerCapacityIdentity,
  recordCapacityFailure,
} from '../src/capacity-registry.mjs'
import {
  appendCapacityAttempt,
  capacityRecordKey,
  capacityRegistryPaths,
  createCapacityAttempt,
  createCapacityRegistry,
  readCapacityAttempts,
  readCapacityRegistry,
  withCapacityRegistryLock,
} from '../src/capacity-registry-store.mjs'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'

const configurationHash = 'a'.repeat(64)
const rotatedConfigurationHash = 'b'.repeat(64)
const credentialGeneration = 'credential-1'
const now = Date.parse('2026-08-21T00:00:00.000Z')
const storeFixture = fileURLToPath(new URL('./fixtures/capacity-store-process.mjs', import.meta.url))

function capacityFailure(overrides = {}) {
  return {
    version: 1,
    category: 'capacity',
    reason: 'quota-exhausted',
    scope: 'capacity-group',
    phase: 'pre-session',
    code: 'provider.usage-limit',
    confidence: 'authoritative',
    ...overrides,
  }
}

function baseRecord(overrides = {}) {
  return createCapacityRecord({
    capacityGroup: 'provider-account-1',
    sourceWorker: 'worker-1',
    configurationHash,
    credentialGeneration,
    now,
    ...overrides,
  })
}

test('Adapter failure protocol distinguishes capacity, identity, and non-capacity failures', () => {
  const rateLimit = parseAdapterFailure({
    ...capacityFailure({ reason: 'rate-limited', retryAtUtc: '2026-08-21T00:02:00Z' }),
  })
  assert.equal(rateLimit.category, 'capacity')
  assert.equal(rateLimit.reason, 'rate-limited')
  assert.equal(rateLimit.retryAtUtc, '2026-08-21T00:02:00.000Z')
  assert.equal(canFailoverCapacityFailure(rateLimit), true)
  assert.equal(disablesCapacity(parseAdapterFailure({
    version: 1, category: 'authentication', reason: 'authentication-invalid',
    scope: 'worker', phase: 'pre-session', code: 'auth.invalid', confidence: 'authoritative',
  })), true)

  const transport = adapterFailureFromError(Object.assign(new Error('socket reset'), { code: 'ECONNRESET' }))
  assert.deepEqual(transport, {
    version: 1, category: 'transport', reason: 'transport-failure', scope: 'request',
    phase: 'pre-session', code: 'econnreset', confidence: 'authoritative',
  })
  assert.equal(canFailoverCapacityFailure(transport), false)
  const forbidden = adapterFailureFromError(Object.assign(new Error('forbidden'), { statusCode: 403 }))
  assert.equal(forbidden.category, 'authentication')
  assert.equal(disablesCapacity(forbidden), false)
  assert.equal(adapterFailureFromError({ adapterFailure: { version: 1, category: 'not-valid' } }).reason, 'protocol-invalid')
  assert.throws(() => parseAdapterFailure({ ...capacityFailure(), category: 'task' }), /does not match/)
})

test('adapter errors retain their original error while exposing a bounded structured observation', () => {
  const error = new Error('provider quota exceeded')
  const annotated = annotateAdapterFailure(error, { phase: 'session' })
  assert.equal(annotated, error)
  assert.equal(annotated.adapterFailure.category, 'capacity')
  assert.equal(annotated.adapterFailure.reason, 'quota-exhausted')
  assert.equal(annotated.adapterFailure.phase, 'session')
  assert.equal(Object.keys(annotated).includes('adapterFailure'), false)
  const wrapped = new AdapterFailureError(capacityFailure())
  assert.equal(wrapped.adapterFailure.reason, 'quota-exhausted')
})

test('capacity state machine grants one half-open probe and excludes ordinary failures', () => {
  const cooldown = recordCapacityFailure(baseRecord(), capacityFailure(), { now, cooldownMs: 30_000, sourceWorker: 'worker-1' })
  assert.equal(cooldown.state, 'cooldown')
  assert.equal(cooldown.generation, 1)
  assert.equal(capacityEligibility(cooldown, { now: now + 29_999 }).eligible, false)
  assert.equal(capacityEligibility(cooldown, { now: now + 30_000 }).requiresProbe, true)
  const acquired = acquireHalfOpenLease(cooldown, { leaseId: 'lease-1', owner: 'worker-1', now: now + 30_000, leaseMs: 10_000 })
  assert.ok(acquired)
  assert.equal(acquired.record.state, 'half-open')
  assert.equal(acquireHalfOpenLease(acquired.record, { leaseId: 'lease-2', owner: 'worker-2', now: now + 30_001 }), null)
  const available = completeHalfOpenLease(acquired.record, { leaseId: 'lease-1', outcome: 'success', now: now + 31_000 })
  assert.equal(available.state, 'available')
  assert.equal(available.lease, null)
  assert.throws(() => recordCapacityFailure(available, {
    version: 1, category: 'protocol', reason: 'protocol-invalid', scope: 'worker',
    phase: 'pre-session', code: 'protocol.invalid', confidence: 'authoritative',
  }), /cannot record protocol/)
  assert.throws(() => completeHalfOpenLease(acquired.record, {
    leaseId: 'lease-1', outcome: 'success', now: now + 41_000,
  }), /expired/)
})

test('disabled credentials reopen only after configuration or credential generation changes', () => {
  const disabled = recordCapacityFailure(baseRecord({ scope: 'worker' }), {
    version: 1, category: 'authentication', reason: 'authentication-invalid', scope: 'worker',
    phase: 'pre-session', code: 'auth.invalid', confidence: 'authoritative',
  }, { now, sourceWorker: 'worker-1' })
  assert.equal(disabled.state, 'disabled')
  assert.equal(invalidateCapacityRecord(disabled, {
    configurationHash, credentialGeneration, now: now + 1000,
  }).state, 'disabled')
  const reopened = invalidateCapacityRecord(disabled, {
    configurationHash: rotatedConfigurationHash, credentialGeneration: 'credential-2', now: now + 1000,
  })
  assert.equal(reopened.state, 'available')
  assert.equal(reopened.configurationHash, rotatedConfigurationHash)
  assert.equal(reopened.credentialGeneration, 'credential-2')
  assert.ok(reopened.generation > disabled.generation)
})

test('only authoritative identity evidence disables and every retry time is bounded', () => {
  const failure = adapterFailureFromError(new Error('quota text from an untrusted response'))
  const record = recordCapacityFailure(baseRecord(), { ...failure, confidence: 'low' }, {
    now, cooldownMs: 24 * 60 * 60 * 1000, sourceWorker: 'worker-1',
  })
  assert.equal(record.state, 'cooldown')
  assert.equal(Date.parse(record.retryAtUtc) - now, 60_000)
  const distantInferredRetry = recordCapacityFailure(baseRecord(), {
    ...failure, confidence: 'low', retryAtUtc: '2030-01-01T00:00:00.000Z',
  }, { now, sourceWorker: 'worker-1' })
  assert.equal(Date.parse(distantInferredRetry.retryAtUtc) - now, 60_000)

  const inferredAuth = adapterFailureFromError(new Error('invalid api key in provider output'))
  assert.equal(inferredAuth.confidence, 'inferred')
  assert.equal(disablesCapacity(inferredAuth), false)
  const inferredRecord = recordCapacityFailure(baseRecord({ scope: 'worker' }), inferredAuth, {
    now, cooldownMs: 24 * 60 * 60 * 1000, sourceWorker: 'worker-1',
  })
  assert.equal(inferredRecord.state, 'cooldown')
  assert.equal(Date.parse(inferredRecord.retryAtUtc) - now, 60_000)

  const statusAuth = adapterFailureFromError(Object.assign(new Error('request rejected'), { status: 401 }))
  assert.equal(statusAuth.confidence, 'authoritative')
  assert.equal(disablesCapacity(statusAuth), true)
  assert.equal(recordCapacityFailure(baseRecord({ scope: 'worker' }), statusAuth, {
    now, sourceWorker: 'worker-1',
  }).state, 'disabled')

  const distantRetry = recordCapacityFailure(baseRecord(), capacityFailure({
    reason: 'rate-limited', retryAtUtc: '2030-01-01T00:00:00.000Z',
  }), { now, cooldownMs: 24 * 60 * 60 * 1000, sourceWorker: 'worker-1' })
  assert.equal(Date.parse(distantRetry.retryAtUtc) - now, 60 * 60 * 1000)
})

test('trusted Worker projection retains the complete OpenCode provider/model tuple', () => {
  assert.deepEqual(projectWorkerCapacityIdentity('opencode-review', {
    adapter: 'opencode-cli', model: 'opencode-go/muse-spark-1.2/provider-model',
  }), {
    provider: 'opencode-go', model: 'muse-spark-1.2/provider-model', worker: 'opencode-review',
  })
  assert.throws(() => projectWorkerCapacityIdentity('dsh-worker', {
    adapter: 'opencode-cli', provider: 'configured-provider', model: 'vendor/model',
  }), /provider does not match/)
})

test('worker-scope keys rotate with the complete trusted provider/model identity', () => {
  const first = capacityRecordKey({
    capacityGroup: 'provider-account-1',
    scope: 'worker',
    identity: { provider: 'provider-1', model: 'model-1', worker: 'worker-1' },
  })
  const rotatedProvider = capacityRecordKey({
    capacityGroup: 'provider-account-1',
    scope: 'worker',
    identity: { provider: 'provider-2', model: 'model-1', worker: 'worker-1' },
  })
  const rotatedModel = capacityRecordKey({
    capacityGroup: 'provider-account-1',
    scope: 'worker',
    identity: { provider: 'provider-1', model: 'model-2', worker: 'worker-1' },
  })
  assert.notEqual(first, rotatedProvider)
  assert.notEqual(first, rotatedModel)
  assert.equal(capacityRecordKey({
    capacityGroup: 'provider-account-1',
    scope: 'capacity-group',
    identity: { provider: 'provider-1', model: 'model-1', worker: 'worker-1' },
  }), capacityRecordKey({
    capacityGroup: 'provider-account-1',
    scope: 'capacity-group',
    identity: { provider: 'provider-2', model: 'model-2', worker: 'worker-2' },
  }))
})

function attempt(overrides = {}) {
  return createCapacityAttempt({
    attemptId: 'attempt-1',
    workRequestId: 'work-request-1',
    routePolicyHash: configurationHash,
    taskClass: 'general',
    workerId: 'worker-1',
    capacityGroup: 'provider-account-1',
    capacityGeneration: 1,
    startState: 'available',
    startedAt: now,
    endedAt: now + 1000,
    result: { outcome: 'capacity-failure', category: 'capacity', reason: 'quota-exhausted' },
    ...overrides,
  })
}

function runStoreProcess(...args) {
  const child = spawn(process.execPath, [storeFixture, ...args.map(String)], {
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  })
  return new Promise(resolve => {
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.on('exit', (code, signal) => resolve({ code, signal, stdout, stderr }))
  })
}

test('durable registry derives opaque keys from complete identity and persists records', async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'dsh-capacity-store-'))
  try {
    const registry = createCapacityRegistry({
      stateRoot, configurationHash, credentialGeneration, now,
      workers: { 'worker-1': { adapter: 'dsh-web', provider: 'provider-1', model: 'model-1', capacityGroup: 'g'.repeat(128) } },
    })
    const failure = capacityFailure({ scope: 'model', reason: 'model-unavailable' })
    const record = await registry.recordFailure({ capacityGroup: 'g'.repeat(128), sourceWorker: 'worker-1', failure, now })
    const key = capacityRecordKey({ capacityGroup: 'g'.repeat(128), scope: 'model', identity: { provider: 'provider-1', model: 'model-1', worker: 'worker-1' } })
    assert.equal(key, Object.keys(await readCapacityRegistry(stateRoot))[0] === 'records' ? Object.keys((await readCapacityRegistry(stateRoot)).records)[0] : key)
    assert.match(key, /^record:[a-f0-9]{64}$/)
    assert.equal(record.state, 'cooldown')
    assert.match(capacityRecordKey({ capacityGroup: 'g'.repeat(128), scope: 'model', provider: 'p'.repeat(32), model: 'm'.repeat(256) }), /^record:[a-f0-9]{64}$/)
    assert.equal((await registry.get(key)).reason, 'model-unavailable')
    assert.ok((await readdir(capacityRegistryPaths(stateRoot).directory)).some(name => name.startsWith('records.')))
  } finally {
    await rm(stateRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})

test('durable worker records publish a new key after trusted provider and model rotation', async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'dsh-capacity-identity-rotation-'))
  try {
    const failure = capacityFailure({ scope: 'worker' })
    const first = createCapacityRegistry({
      stateRoot, configurationHash, credentialGeneration, now,
      workers: { 'worker-1': { adapter: 'dsh-web', provider: 'provider-1', model: 'model-1', capacityGroup: 'shared' } },
    })
    await first.recordFailure({ capacityGroup: 'shared', sourceWorker: 'worker-1', failure, now })
    const firstKeys = Object.keys((await readCapacityRegistry(stateRoot)).records)
    const rotated = createCapacityRegistry({
      stateRoot, configurationHash, credentialGeneration, now,
      workers: { 'worker-1': { adapter: 'dsh-web', provider: 'provider-2', model: 'model-2', capacityGroup: 'shared' } },
    })
    await rotated.recordFailure({ capacityGroup: 'shared', sourceWorker: 'worker-1', failure, now: now + 1 })
    const rotatedKeys = Object.keys((await readCapacityRegistry(stateRoot)).records)
    assert.equal(firstKeys.length, 1)
    assert.equal(rotatedKeys.length, 2)
    assert.ok(rotatedKeys.some(key => !firstKeys.includes(key)))
  } finally {
    await rm(stateRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})

test('attempt journal is bounded, idempotent, and survives immutable compaction', { timeout: 60_000 }, async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'dsh-capacity-attempts-'))
  try {
    const first = await appendCapacityAttempt(stateRoot, attempt())
    assert.deepEqual(await appendCapacityAttempt(stateRoot, attempt()), first)
    const writers = Promise.all(Array.from({ length: 68 }, (_, index) => appendCapacityAttempt(stateRoot, attempt({
      attemptId: `attempt-${index + 2}`,
      startedAt: now + index + 2,
      endedAt: now + index + 3,
    }), { waitMs: 60_000 })))
    const readers = Promise.all(Array.from({ length: 4 }, async () => {
      let previous = 1
      for (let index = 0; index < 68; index += 1) {
        const current = (await readCapacityAttempts(stateRoot)).length
        assert.ok(current >= previous)
        previous = current
        await new Promise(resolvePromise => setTimeout(resolvePromise, 1))
      }
      return previous
    }))
    await Promise.all([writers, readers])
    assert.equal((await readCapacityAttempts(stateRoot)).length, 69)
    const files = await readdir(capacityRegistryPaths(stateRoot).directory)
    assert.ok(files.some(name => name.startsWith('attempt-base.')))
    assert.ok(files.filter(name => name.startsWith('attempt-event.')).length < 68)
  } finally {
    await rm(stateRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})

test('three real processes contend through owner-addressed leases and retain every attempt', { timeout: 60_000 }, async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'dsh-capacity-processes-'))
  try {
    const results = await Promise.all(['a', 'b', 'c'].map(id => runStoreProcess('append', stateRoot, id)))
    assert.deepEqual(results.map(result => result.code), [0, 0, 0])
    assert.deepEqual((await readCapacityAttempts(stateRoot)).map(item => item.attemptId).sort(), [
      'attempt-a', 'attempt-b', 'attempt-c',
    ])
    const leases = (await readdir(capacityRegistryPaths(stateRoot).directory)).filter(name => name.startsWith('registry-lease.'))
    assert.equal(leases.length, 0)
  } finally {
    await rm(stateRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})

test('reader retries a compaction deletion race instead of returning a seeded empty journal', { timeout: 60_000 }, async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'dsh-capacity-reader-race-'))
  try {
    await appendCapacityAttempt(stateRoot, attempt())
    const original = await readCapacityAttempts(stateRoot)
    assert.equal(original.length, 1)
    const result = await withCapacityRegistryLock(stateRoot, async (_paths, lease) => {
      await lease.assertOwner()
      return readCapacityAttempts(stateRoot)
    })
    assert.deepEqual(result, original)
    await writeFile(join(capacityRegistryPaths(stateRoot).directory, 'attempt-event.999.0.corrupt.json'), '{not-json\n', 'utf8')
    await assert.rejects(readCapacityAttempts(stateRoot), /Unexpected token|Expected property|invalid/i)
  } finally {
    await rm(stateRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})
