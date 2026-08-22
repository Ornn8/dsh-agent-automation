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
  resolveProcessIdentity,
  withCapacityRegistryLock,
} from '../src/capacity-registry-store.mjs'
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
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
  return waitStoreProcess(startStoreProcess(...args))
}

function startStoreProcess(...args) {
  return spawn(process.execPath, [storeFixture, ...args.map(String)], {
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  })
}

function waitStoreProcess(child) {
  return new Promise(resolve => {
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.on('exit', (code, signal) => resolve({ code, signal, stdout, stderr }))
  })
}

async function assertReleasedGate(paths) {
  const files = await readdir(paths.directory)
  assert.equal(files.filter(name => name === 'registry.lock.reclaim' || name === 'registry.lock.quarantine').length, 0)
  try {
    assert.ok((await stat(paths.lockPath)).isDirectory())
    assert.deepEqual(await readdir(paths.lockPath), [])
  } catch (error) {
    assert.equal(error?.code, 'ENOENT')
  }
}

async function waitForFile(path, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      await readFile(path, 'utf8')
      return
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
      await new Promise(resolve => setTimeout(resolve, 5))
    }
  }
  throw new Error(`Timed out waiting for ${path}`)
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

test('24 real processes have one canonical owner and one callback each', { timeout: 60_000 }, async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'dsh-capacity-mutex-'))
  try {
    const results = await Promise.all(Array.from({ length: 24 }, (_, index) => runStoreProcess('lock', stateRoot, `worker-${index}`)))
    assert.ok(results.every(result => result.code === 0), results.map(result => `${result.code}:${result.stderr}`).join('\n'))
    const state = JSON.parse(await readFile(join(capacityRegistryPaths(stateRoot).directory, 'lock-observations.json'), 'utf8'))
    assert.equal(state.maxActive, 1)
    assert.equal(Object.keys(state.calls).length, 24)
    assert.ok(Object.values(state.calls).every(count => count === 1))
    await assertReleasedGate(capacityRegistryPaths(stateRoot))
  } finally {
    await rm(stateRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})

test('a live callback remains exclusive after its lease duration', { timeout: 60_000 }, async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'dsh-capacity-overlease-'))
  try {
    const paths = capacityRegistryPaths(stateRoot)
    const first = startStoreProcess('overlease', stateRoot, 'first')
    await waitForFile(`${paths.directory}/lock-observations.json.first.ready`)
    await new Promise(resolve => setTimeout(resolve, 140))
    const second = startStoreProcess('overlease', stateRoot, 'second')
    const results = await Promise.all([waitStoreProcess(first), waitStoreProcess(second)])
    assert.ok(results.every(result => result.code === 0), results.map(result => result.stderr).join('\n'))
    const state = JSON.parse(await readFile(join(paths.directory, 'lock-observations.json'), 'utf8'))
    assert.equal(state.maxActive, 1)
    assert.deepEqual(Object.values(state.calls).sort(), [1, 1])
  } finally {
    await rm(stateRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})

test('a PID-reused owner is reclaimable only when its process start identity differs', { timeout: 60_000 }, async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'dsh-capacity-pid-reuse-'))
  try {
    const paths = capacityRegistryPaths(stateRoot)
    await mkdir(paths.directory, { recursive: true })
    await mkdir(paths.lockPath)
    await writeFile(join(paths.lockPath, 'registry-owner.reused-owner.json'), `${JSON.stringify({
      version: 1,
      ownerToken: 'reused-owner',
      fence: 5_000,
      pid: process.pid,
      processIdentity: 'linux:reused-boot:0',
      acquiredAt: new Date(now - 2_000).toISOString(),
      expiresAt: new Date(now - 1).toISOString(),
    })}\n`, 'utf8')
    let acquiredFence = 0
    await withCapacityRegistryLock(stateRoot, async (_paths, lease) => {
      acquiredFence = lease.fence
    }, { now, waitMs: 5_000, leaseMs: 1_000 })
    assert.ok(acquiredFence > 5_000)
  } finally {
    await rm(stateRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})

test('process identity fails closed when Linux boot identity cannot be read', async () => {
  const read = async path => {
    if (path === '/proc/123/stat') return `(node) S ${Array.from({ length: 19 }, () => '1').join(' ')}`
    const error = Object.assign(new Error('boot identity missing'), { code: 'ENOENT' })
    throw error
  }
  await assert.rejects(resolveProcessIdentity(123, { platform: 'linux', readFile: read }), /boot identity|boot id|ENOENT/)
})

test('process identity fails closed when macOS ps is missing', async () => {
  const runCommand = async () => {
    throw Object.assign(new Error('ps missing'), { code: 'ENOENT' })
  }
  await assert.rejects(resolveProcessIdentity(123, { platform: 'darwin', runCommand }), /ps|missing|unavailable/i)
})

test('process identity returns null when macOS ps clearly reports a missing PID', async () => {
  const runCommand = async () => {
    throw new Error('/bin/ps exited with code 1: signal null')
  }
  assert.equal(await resolveProcessIdentity(123, { platform: 'darwin', runCommand }), null)
})

test('process identity rejects empty macOS output instead of reclaiming a gate', async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'dsh-capacity-empty-identity-'))
  try {
    const paths = capacityRegistryPaths(stateRoot)
    await mkdir(paths.directory, { recursive: true })
    await mkdir(paths.lockPath)
    await writeFile(join(paths.lockPath, 'registry-owner.empty.json'), `${JSON.stringify({
      version: 1, ownerToken: 'empty', fence: 10, pid: process.pid,
      processIdentity: 'wrong-process-start', acquiredAt: '1970-01-01T00:00:00.000Z',
      expiresAt: '1970-01-01T00:00:00.500Z',
    })}\n`, 'utf8')
    const runCommand = async () => ({ stdout: '' })
    await assert.rejects(withCapacityRegistryLock(stateRoot, async () => undefined, {
      now: 1_000,
      processIdentity: pid => resolveProcessIdentity(pid, { platform: 'darwin', runCommand }),
    }), /empty/)
    assert.deepEqual(await readdir(paths.lockPath), ['registry-owner.empty.json'])
  } finally {
    await rm(stateRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})

test('process identity returns null only when Windows reports the target PID absent', async () => {
  const runCommand = async () => {
    throw new Error('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe exited with code 3: target absent')
  }
  assert.equal(await resolveProcessIdentity(123, {
    platform: 'win32',
    powershellPath: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    runCommand,
  }), null)
})

test('process identity requires an aborted child runner to acknowledge close', { timeout: 10_000 }, async () => {
  let child
  let closed = false
  let runnerSettled = false
  const runCommand = async (_command, _args, options) => {
    child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'])
    options.signal.addEventListener('abort', () => child.kill(), { once: true })
    await once(child, 'close')
    closed = true
    await new Promise(resolve => setTimeout(resolve, 3_000))
    runnerSettled = true
    return { stdout: '' }
  }
  const platform = process.platform === 'win32' ? 'win32' : 'darwin'
  const options = platform === 'win32'
    ? { platform, powershellPath: process.execPath, runCommand }
    : { platform, psPath: process.execPath, runCommand }
  await assert.rejects(resolveProcessIdentity(123, options), /runner did not settle/)
  assert.equal(closed, true)
  assert.equal(runnerSettled, false)
})

test('identity probe failure fails acquisition without reclaiming the old gate', async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'dsh-capacity-identity-timeout-'))
  try {
    const paths = capacityRegistryPaths(stateRoot)
    await mkdir(paths.directory, { recursive: true })
    await mkdir(paths.lockPath)
    await writeFile(join(paths.lockPath, 'registry-owner.probe.json'), `${JSON.stringify({
      version: 1,
      ownerToken: 'probe',
      fence: 10,
      pid: process.pid,
      processIdentity: 'wrong-process-start',
      acquiredAt: '1970-01-01T00:00:00.000Z',
      expiresAt: '1970-01-01T00:00:00.500Z',
    })}\n`, 'utf8')
    await assert.rejects(withCapacityRegistryLock(stateRoot, async () => undefined, {
      now: 1_000,
      waitMs: 100,
      processIdentity: async () => { throw new Error('identity probe unavailable') },
    }), /identity probe unavailable/)
    assert.equal((await readdir(paths.lockPath)).length, 1)
  } finally {
    await rm(stateRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})

test('Windows leases defer local identity probing until an expired owner must be checked', { skip: process.platform !== 'win32' }, async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'dsh-capacity-windows-local-identity-'))
  try {
    let lease
    await withCapacityRegistryLock(stateRoot, async (paths) => {
      const ownerName = (await readdir(paths.lockPath)).find(name => name.startsWith('registry-owner.') && name.endsWith('.json'))
      assert.ok(ownerName)
      lease = JSON.parse(await readFile(join(paths.lockPath, ownerName), 'utf8'))
    })
    assert.equal(lease.pid, process.pid)
    assert.equal(lease.processIdentity, undefined)
    assert.match(lease.acquiredAt, /^20\d\d-/)
  } finally {
    await rm(stateRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})

test('Windows timestamp identity keeps an active PID and rejects reuse when the lease has no stored identity', { skip: process.platform !== 'win32', timeout: 10_000 }, async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'dsh-capacity-windows-timestamp-identity-'))
  const acquiredAt = Date.parse('2026-08-21T00:00:00.000Z')
  const writeExpiredOwner = async (ownerToken) => {
    const paths = capacityRegistryPaths(stateRoot)
    await mkdir(paths.directory, { recursive: true })
    await mkdir(paths.lockPath)
    await writeFile(join(paths.lockPath, `registry-owner.${ownerToken}.json`), `${JSON.stringify({
      version: 1, ownerToken, fence: 10, pid: process.pid,
      acquiredAt: new Date(acquiredAt).toISOString(),
      expiresAt: new Date(acquiredAt + 1).toISOString(),
    })}\n`, 'utf8')
  }
  try {
    await writeExpiredOwner('active')
    await assert.rejects(withCapacityRegistryLock(stateRoot, async () => undefined, {
      now: acquiredAt + 1_000,
      waitMs: 20,
      processIdentity: async () => `windows:${new Date(acquiredAt - 1).toISOString()}`,
    }), /busy/)
    assert.equal((await readdir(capacityRegistryPaths(stateRoot).lockPath)).length, 1)

    await rm(capacityRegistryPaths(stateRoot).lockPath, { recursive: true, force: true })
    await writeExpiredOwner('reused')
    let callbacks = 0
    await withCapacityRegistryLock(stateRoot, async () => { callbacks += 1 }, {
      now: acquiredAt + 2_000,
      processIdentity: async () => `windows:${new Date(acquiredAt + 1).toISOString()}`,
    })
    assert.equal(callbacks, 1)

    await rm(capacityRegistryPaths(stateRoot).lockPath, { recursive: true, force: true })
    await writeExpiredOwner('dead')
    await withCapacityRegistryLock(stateRoot, async () => { callbacks += 1 }, {
      now: acquiredAt + 3_000,
      processIdentity: async () => null,
    })
    assert.equal(callbacks, 2)
  } finally {
    await rm(stateRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})

test('a suspended owner remains exclusive after its lease duration', { timeout: 60_000 }, async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'dsh-capacity-suspended-'))
  try {
    const paths = capacityRegistryPaths(stateRoot)
    const owner = startStoreProcess('hang', stateRoot, 'owner')
    await waitForFile(`${paths.directory}/hang.ready`)
    await new Promise(resolve => setTimeout(resolve, 150))
    const contender = await runStoreProcess('busy', stateRoot, 'contender')
    assert.equal(contender.code, 23, contender.stderr)
    await writeFile(`${paths.directory}/hang.go`, 'go\n', 'utf8')
    const result = await waitStoreProcess(owner)
    assert.equal(result.code, 0, result.stderr)
  } finally {
    await rm(stateRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})

test('owner-addressed release leaves a replacement gate intact', { timeout: 60_000 }, async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'dsh-capacity-release-race-'))
  try {
    const paths = capacityRegistryPaths(stateRoot)
    const owner = startStoreProcess('release-race', stateRoot, 'owner')
    await waitForFile(`${paths.directory}/release-race.ready`)
    const ownerName = (await readdir(paths.lockPath)).find(name => name.startsWith('registry-owner.') && name.endsWith('.json'))
    assert.ok(ownerName)
    const oldLease = JSON.parse(await readFile(join(paths.lockPath, ownerName), 'utf8'))
    await rename(paths.lockPath, paths.quarantinePath)
    await mkdir(paths.lockPath)
    const replacement = {
      ...oldLease,
      ownerToken: 'replacement-owner',
      fence: oldLease.fence + 1,
      pid: process.pid,
      acquiredAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }
    await writeFile(join(paths.lockPath, 'registry-owner.replacement-owner.json'), `${JSON.stringify(replacement)}\n`, 'utf8')
    await writeFile(join(paths.directory, 'release-race.go'), 'go\n', 'utf8')
    const result = await waitStoreProcess(owner)
    assert.notEqual(result.code, 0)
    const surviving = JSON.parse(await readFile(join(paths.lockPath, 'registry-owner.replacement-owner.json'), 'utf8'))
    assert.equal(surviving.ownerToken, 'replacement-owner')
    assert.equal(surviving.fence, oldLease.fence + 1)
  } finally {
    await rm(stateRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})

test('a crash during canonical gate acquisition is recoverable', { timeout: 60_000 }, async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'dsh-capacity-acquire-crash-'))
  try {
    const crashed = await runStoreProcess('partial', stateRoot, 'partial')
    assert.equal(crashed.code, 17)
    const recovered = await runStoreProcess('append', stateRoot, 'recovered')
    assert.equal(recovered.code, 0, recovered.stderr)
    assert.deepEqual((await readCapacityAttempts(stateRoot)).map(item => item.attemptId), ['attempt-recovered'])
  } finally {
    await rm(stateRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})

test('a crashed owner is reclaimed once without deleting the replacement owner', { timeout: 60_000 }, async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'dsh-capacity-crash-'))
  try {
    const crashed = await runStoreProcess('crash', stateRoot, 'crashed')
    assert.equal(crashed.code, 17)
    await new Promise(resolve => setTimeout(resolve, 150))
    const replacement = await runStoreProcess('lock', stateRoot, 'replacement')
    assert.equal(replacement.code, 0, replacement.stderr)
    await assertReleasedGate(capacityRegistryPaths(stateRoot))
  } finally {
    await rm(stateRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})

test('successful acquisition bounds stale legacy leases without deleting active leases', async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'dsh-capacity-legacy-cleanup-'))
  try {
    const paths = capacityRegistryPaths(stateRoot)
    await mkdir(paths.directory, { recursive: true })
    const current = Date.now()
    const lease = (ownerToken, fence, expiresAt) => ({
      version: 1,
      ownerToken,
      fence,
      acquiredAt: new Date(current - 1_000).toISOString(),
      expiresAt: new Date(expiresAt).toISOString(),
    })
    await writeFile(join(paths.directory, 'registry-lease.crashed-owner.json'), `${JSON.stringify(lease('crashed-owner', 2, current - 1))}\n`, 'utf8')
    await writeFile(join(paths.directory, 'registry-lease.live-owner.json'), `${JSON.stringify(lease('live-owner', 3, current + 60_000))}\n`, 'utf8')
    await withCapacityRegistryLock(stateRoot, async () => undefined, { now: current, waitMs: 5_000, leaseMs: 5_000 })
    await assert.rejects(readFile(join(paths.directory, 'registry-lease.crashed-owner.json'), 'utf8'), error => error.code === 'ENOENT')
    assert.equal(JSON.parse(await readFile(join(paths.directory, 'registry-lease.live-owner.json'), 'utf8')).ownerToken, 'live-owner')
  } finally {
    await rm(stateRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})

test('an expired operation fails once and is never replayed by the lock layer', { timeout: 60_000 }, async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'dsh-capacity-expire-'))
  try {
    const result = await runStoreProcess('expire', stateRoot, 'expired')
    assert.notEqual(result.code, 0)
    assert.match(result.stderr, /intentional expired callback failure/)
    const state = JSON.parse(await readFile(join(capacityRegistryPaths(stateRoot).directory, 'expire-observation.json'), 'utf8'))
    assert.equal(state.calls, 1)
  } finally {
    await rm(stateRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})

test('fencing remains above the historical high water mark after a clock rollback', async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'dsh-capacity-fence-rollback-'))
  try {
    const paths = capacityRegistryPaths(stateRoot)
    await mkdir(paths.lockPath, { recursive: true })
    await writeFile(join(paths.lockPath, 'registry-owner.old-generation.json'), `${JSON.stringify({
      version: 1,
      ownerToken: 'old-generation',
      fence: 5_000,
      acquiredAt: '1970-01-01T00:00:00.000Z',
      expiresAt: '1970-01-01T00:00:00.500Z',
    })}\n`, 'utf8')
    let acquiredFence = 0
    await withCapacityRegistryLock(stateRoot, async (_paths, lease) => {
      acquiredFence = lease.fence
    }, { now: 1_000, waitMs: 5_000, leaseMs: 1_000 })
    assert.ok(acquiredFence > 5_000)
    const highWater = JSON.parse(await readFile(paths.fencePath, 'utf8'))
    assert.equal(highWater.fence, acquiredFence)
    await mkdir(paths.lockPath)
    await writeFile(join(paths.lockPath, 'registry-owner.late-generation.json'), `${JSON.stringify({
      version: 1,
      ownerToken: 'late-generation',
      fence: 5_001,
      acquiredAt: '1970-01-01T00:00:00.000Z',
      expiresAt: '1970-01-01T00:00:00.500Z',
    })}\n`, 'utf8')
    let laterFence = 0
    await withCapacityRegistryLock(stateRoot, async (_paths, lease) => {
      laterFence = lease.fence
    }, { now: 1_000, waitMs: 5_000, leaseMs: 1_000 })
    assert.ok(laterFence > acquiredFence)
  } finally {
    await rm(stateRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})

test('stale reclaim markers are recovered through one fixed quarantine path', { timeout: 60_000 }, async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'dsh-capacity-reclaim-'))
  try {
    const paths = capacityRegistryPaths(stateRoot)
    await mkdir(paths.directory, { recursive: true })
    const stale = {
      version: 1,
      ownerToken: 'stale-reclaimer',
      fence: 10,
      acquiredAt: '2020-01-01T00:00:00.000Z',
      expiresAt: '2020-01-01T00:01:00.000Z',
    }
    await writeFile(paths.reclaimPath, `${JSON.stringify(stale)}\n`, 'utf8')
    await writeFile(paths.lockPath, `${JSON.stringify({ ...stale, ownerToken: 'stale-owner' })}\n`, 'utf8')
    const results = await Promise.all(['a', 'b', 'c'].map(id => runStoreProcess('append', stateRoot, id)))
    assert.ok(results.every(result => result.code === 0), results.map(result => result.stderr).join('\n'))
    const files = await readdir(paths.directory)
    assert.ok(files.length < 20)
    await assertReleasedGate(paths)
    assert.deepEqual((await readCapacityAttempts(stateRoot)).map(item => item.attemptId).sort(), ['attempt-a', 'attempt-b', 'attempt-c'])
  } finally {
    await rm(stateRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})

test('registry clock defaults to live time and accepts an injected clock for cooldown probes', async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'dsh-capacity-clock-'))
  try {
    let current = now
    const registry = createCapacityRegistry({
      stateRoot, configurationHash, credentialGeneration,
      workers: { 'worker-1': { adapter: 'dsh-web', provider: 'provider-1', model: 'model-1', capacityGroup: 'clock-group' } },
      now: () => current,
    })
    const failure = capacityFailure({ scope: 'capacity-group' })
    const record = await registry.recordFailure({ capacityGroup: 'clock-group', sourceWorker: 'worker-1', failure, cooldownMs: 1_000 })
    const key = capacityRecordKey({ capacityGroup: 'clock-group', scope: 'capacity-group', identity: { provider: 'provider-1', model: 'model-1', worker: 'worker-1' } })
    assert.equal(record.state, 'cooldown')
    assert.equal(await registry.acquireHalfOpenLease({ key, leaseId: 'probe-before', owner: 'worker-1' }), null)
    current += 1_001
    const probe = await registry.acquireHalfOpenLease({ key, leaseId: 'probe-after', owner: 'worker-1' })
    assert.ok(probe)
  } finally {
    await rm(stateRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})

test('registry default clock is evaluated for each decision', async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'dsh-capacity-live-clock-'))
  try {
    const registry = createCapacityRegistry({
      stateRoot, configurationHash, credentialGeneration,
      workers: { 'worker-1': { adapter: 'dsh-web', provider: 'provider-1', model: 'model-1', capacityGroup: 'live-clock-group' } },
    })
    const failure = capacityFailure({ scope: 'capacity-group' })
    const record = await registry.recordFailure({ capacityGroup: 'live-clock-group', sourceWorker: 'worker-1', failure, cooldownMs: 30 })
    const key = capacityRecordKey({ capacityGroup: 'live-clock-group', scope: 'capacity-group' })
    assert.equal(record.state, 'cooldown')
    await new Promise(resolve => setTimeout(resolve, 60))
    assert.ok(await registry.acquireHalfOpenLease({ key, leaseId: 'live-probe', owner: 'worker-1' }))
  } finally {
    await rm(stateRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})

test('three real processes contend through canonical leases and retain every attempt', { timeout: 60_000 }, async () => {
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
