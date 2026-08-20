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

const configurationHash = 'a'.repeat(64)
const rotatedConfigurationHash = 'b'.repeat(64)
const credentialGeneration = 'credential-1'
const now = Date.parse('2026-08-21T00:00:00.000Z')

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
