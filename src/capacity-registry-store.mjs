// @ts-check

import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { access, lstat, mkdir, open, readFile, readdir, rm, rename, rmdir } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { run } from './common.mjs'
import {
  ADAPTER_FAILURE_CATEGORIES,
  ADAPTER_FAILURE_REASONS,
  parseAdapterFailure,
} from './capacity-failure.mjs'
import {
  CAPACITY_RECORD_SCOPES,
  CAPACITY_RECORD_STATES,
  acquireHalfOpenLease,
  capacityEligibility,
  createCapacityRecord,
  invalidateCapacityRecord,
  parseCapacityRecord,
  projectWorkerCapacityIdentity,
  recordCapacityFailure,
  completeHalfOpenLease,
  scopeCapacityIdentity,
} from './capacity-registry.mjs'

export const CAPACITY_ATTEMPT_RESULTS = Object.freeze([
  'claimed', 'completed', 'blocked', 'capacity-failure', 'capacity-deferred', 'failed', 'timed-out',
])

const STATE_SET = new Set(CAPACITY_RECORD_STATES)
const SCOPE_SET = new Set(CAPACITY_RECORD_SCOPES)
const RESULT_SET = new Set(CAPACITY_ATTEMPT_RESULTS)
const CATEGORY_SET = new Set(ADAPTER_FAILURE_CATEGORIES)
const REASON_SET = new Set(ADAPTER_FAILURE_REASONS)
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const DIGEST = /^[a-f0-9]{64}$/
const MAX_ATTEMPTS = 10_000
const DEFAULT_LOCK_WAIT_MS = 30_000
const MAX_LOCK_WAIT_MS = 60_000
const DEFAULT_LOCK_LEASE_MS = 15 * 60 * 1000
const MIN_LOCK_LEASE_MS = 100
const MAX_LOCK_LEASE_MS = 30 * 60 * 1000
const PROCESS_IDENTITY_TIMEOUT_MS = 5_000
const PROCESS_IDENTITY_TERMINATION_GRACE_MS = 2_500
const ATTEMPT_COMPACTION_THRESHOLD = 64
const READ_RETRIES = 8
const STALE_LEASE_CLEANUP_LIMIT = 64
const LOCK_RECLAIM_MARKER = 'registry.lock.reclaim'
const LOCK_QUARANTINE = 'registry.lock.quarantine'
const FENCE_HIGH_WATER = 'registry-fence.json'
const GATE_OWNER_PREFIX = 'registry-owner'
const RECLAIM_PENDING_PREFIX = 'registry-reclaim'
const GATE_OWNER_FILE_PATTERN = /^registry-owner\.[A-Za-z0-9._:-]{1,128}\.json$/

/** @typedef {{provider?: string|null, model?: string|null, worker?: string|null}} CapacityIdentity */
/** @typedef {{stateRoot: string, configurationHash: string, credentialGeneration: string, workers?: Record<string, any>, now?: number|(() => number)}} RegistryOptions */
/** @typedef {{key?: string, capacityGroup: string, scope?: string, sourceWorker: string, failure: unknown, now?: number, cooldownMs?: number}} RegistryFailureInput */
/** @typedef {{key: string, leaseId: string, owner: string, now?: number, leaseMs?: number}} RegistryLeaseInput */
/** @typedef {{key: string, leaseId: string, outcome: string, failure?: unknown, now?: number, cooldownMs?: number, sourceWorker?: string}} RegistryCompletionInput */
/** @typedef {{workerId: string, leaseId: string, owner: string, now?: number, leaseMs?: number}} RegistryProbeClaimInput */
/** @typedef {{workerId: string, capacityGroup: string, identity: CapacityIdentity, leases: {key: string, scope: string, leaseId: string, identity: CapacityIdentity}[]}} RegistryProbe */
/** @typedef {{probe: RegistryProbe, outcome: string, failure?: unknown, now?: number, cooldownMs?: number}} RegistryProbeCompletionInput */

/** @param {unknown} value @param {string} name @returns {string} */
function identifier(value, name) {
  if (typeof value !== 'string' || !IDENTIFIER.test(value)) throw new Error(`${name} must be a bounded identifier`)
  return value
}

/** @param {unknown} value @param {string} name @returns {string} */
function timestamp(value, name) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new Error(`${name} must be an ISO timestamp`)
  return new Date(value).toISOString()
}

/** @param {unknown} value @param {string} name @returns {string} */
function digest(value, name) {
  if (typeof value !== 'string' || !DIGEST.test(value)) throw new Error(`${name} must be a SHA-256 digest`)
  return value
}

/** @param {string} reason @returns {string} */
function categoryForReason(reason) {
  if (['quota-exhausted', 'rate-limited', 'model-unavailable', 'provider-unavailable'].includes(reason)) return 'capacity'
  if (reason === 'authentication-invalid') return 'authentication'
  if (reason === 'billing-disabled') return 'billing'
  if (reason === 'transport-failure') return 'transport'
  if (reason === 'protocol-invalid') return 'protocol'
  if (reason === 'host-failure') return 'host'
  return 'task'
}

/** @param {unknown} value @param {string[]} allowed @param {string} name @returns {Record<string, any>} */
function exactKeys(value, allowed, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} must be an object`)
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`${name} has unknown field ${key}`)
  return /** @type {Record<string, any>} */ (value)
}

/** @param {unknown} error @returns {string|undefined} */
function errorCode(error) {
  const code = error && typeof error === 'object' ? /** @type {{code?: unknown}} */ (error).code : undefined
  return typeof code === 'string' ? code : undefined
}

/** @param {string} stateRoot */
export function capacityRegistryPaths(stateRoot) {
  if (typeof stateRoot !== 'string' || !isAbsolute(stateRoot)) throw new Error('capacity stateRoot must be absolute')
  const directory = join(resolve(stateRoot), 'capacity')
  return {
    directory,
    registryPath: join(directory, 'records.json'),
    recordPrefix: 'records',
    attemptsEventPrefix: 'attempt-event',
    attemptsBasePrefix: 'attempt-base',
    leasePrefix: 'registry-lease',
    lockPath: join(directory, 'registry.lock'),
    reclaimPath: join(directory, LOCK_RECLAIM_MARKER),
    quarantinePath: join(directory, LOCK_QUARANTINE),
    fencePath: join(directory, FENCE_HIGH_WATER),
  }
}

/** Generate a bounded opaque key from the complete trusted tuple. */
/** @param {{capacityGroup: string, scope?: string, workerId?: string, provider?: string, model?: string, identity?: CapacityIdentity}} input */
export function capacityRecordKey(input) {
  const scope = input.scope ?? 'capacity-group'
  if (!SCOPE_SET.has(scope)) throw new Error(`Unsupported capacity record scope ${scope}`)
  const capacityGroup = typeof input.capacityGroup === 'string' ? input.capacityGroup : ''
  if (!capacityGroup || capacityGroup.length > 128 || /[\r\n`]/.test(capacityGroup)) throw new Error('capacityGroup must be bounded text')
  const identity = input.identity ?? {
    provider: input.provider ?? null,
    model: input.model ?? null,
    worker: input.workerId ?? null,
  }
  // Keep the sharing semantics of each scope, while binding every identity
  // field that can distinguish a record at that scope. In particular, a
  // worker record must rotate when its trusted provider or model changes.
  const tuple = scope === 'provider'
    ? [scope, capacityGroup, identity.provider ?? null]
    : scope === 'model'
      ? [scope, capacityGroup, identity.provider ?? null, identity.model ?? null]
      : scope === 'worker'
        ? [scope, capacityGroup, identity.provider ?? null, identity.model ?? null, identity.worker ?? null]
        : [scope, capacityGroup]
  return `record:${createHash('sha256').update(JSON.stringify(tuple)).digest('hex')}`
}

/** Strictly validate one bounded attempt journal entry. */
/** @param {unknown} value @returns {Record<string, any>} */
export function parseCapacityAttempt(value) {
  const object = exactKeys(value, [
    'version', 'attemptId', 'workRequestId', 'routePolicyHash', 'taskClass', 'workerId',
    'capacityGroup', 'capacityGeneration', 'capacityGenerationHash', 'startState', 'startedAt', 'endedAt', 'result',
  ], 'Capacity attempt')
  if (object.version !== 1) throw new Error('Capacity attempt version must be 1')
  const startState = object.startState
  if (!STATE_SET.has(startState)) throw new Error('Capacity attempt startState is unsupported')
  const capacityGenerationHash = object.capacityGenerationHash === undefined || object.capacityGenerationHash === null
    ? null : digest(object.capacityGenerationHash, 'Capacity attempt capacityGenerationHash')
  const result = exactKeys(object.result, ['outcome', 'category', 'reason'], 'Capacity attempt result')
  if (!RESULT_SET.has(result.outcome)) throw new Error('Capacity attempt result outcome is unsupported')
  const category = result.category === undefined || result.category === null ? null : identifier(result.category, 'Capacity attempt result category')
  if (category !== null && !CATEGORY_SET.has(category)) throw new Error('Capacity attempt result category is unsupported')
  const reason = result.reason === undefined || result.reason === null ? null : identifier(result.reason, 'Capacity attempt result reason')
  if (reason !== null && !REASON_SET.has(reason)) throw new Error('Capacity attempt result reason is unsupported')
  if ((category === null) !== (reason === null)) throw new Error('Capacity attempt result category and reason must be paired')
  if (category !== null && reason !== null && categoryForReason(reason) !== category) throw new Error('Capacity attempt result category does not match reason')
  const startedAt = timestamp(object.startedAt, 'Capacity attempt startedAt')
  const endedAt = object.endedAt === null || object.endedAt === undefined ? null : timestamp(object.endedAt, 'Capacity attempt endedAt')
  if (endedAt !== null && Date.parse(endedAt) < Date.parse(startedAt)) throw new Error('Capacity attempt endedAt precedes startedAt')
  return {
    version: 1,
    attemptId: identifier(object.attemptId, 'Capacity attempt attemptId'),
    workRequestId: identifier(object.workRequestId, 'Capacity attempt workRequestId'),
    routePolicyHash: digest(object.routePolicyHash, 'Capacity attempt routePolicyHash'),
    taskClass: identifier(object.taskClass, 'Capacity attempt taskClass'),
    workerId: identifier(object.workerId, 'Capacity attempt workerId'),
    capacityGroup: identifier(object.capacityGroup, 'Capacity attempt capacityGroup'),
    capacityGeneration: Number.isSafeInteger(object.capacityGeneration) && object.capacityGeneration >= 0
      ? object.capacityGeneration : (() => { throw new Error('Capacity attempt capacityGeneration must be a non-negative integer') })(),
    capacityGenerationHash,
    startState,
    startedAt,
    endedAt,
    result: { outcome: result.outcome, category, reason },
  }
}

/** Create a bounded attempt journal entry without recording provider output. */
/** @param {Record<string, any>} input @returns {Record<string, any>} */
export function createCapacityAttempt(input) {
  return parseCapacityAttempt({
    version: 1,
    attemptId: input.attemptId,
    workRequestId: input.workRequestId,
    routePolicyHash: input.routePolicyHash,
    taskClass: input.taskClass,
    workerId: input.workerId,
    capacityGroup: input.capacityGroup,
    capacityGeneration: input.capacityGeneration,
    capacityGenerationHash: input.capacityGenerationHash ?? null,
    startState: input.startState,
    startedAt: new Date(input.startedAt ?? Date.now()).toISOString(),
    endedAt: input.endedAt === undefined || input.endedAt === null ? null : new Date(input.endedAt).toISOString(),
    result: input.result,
  })
}

/** @param {unknown} value @returns {Record<string, any>} */
function parseRegistryDocument(value) {
  const object = exactKeys(value, ['version', 'records'], 'Capacity registry')
  if (object.version !== 1 || !object.records || typeof object.records !== 'object' || Array.isArray(object.records)) throw new Error('Capacity registry document is invalid')
  /** @type {Record<string, any>} */
  const records = {}
  for (const [key, record] of Object.entries(object.records)) {
    identifier(key, 'Capacity registry record key')
    const normalized = parseCapacityRecord(record)
    const expectedKey = capacityRecordKey({ capacityGroup: normalized.capacityGroup, scope: normalized.scope, identity: normalized.capacityIdentity })
    if (key !== expectedKey) throw new Error(`Capacity registry record key ${key} does not match the trusted identity key`)
    records[key] = normalized
  }
  return { version: 1, records }
}

/** @param {unknown} value @param {string} name @returns {{version: 1, fence: number, revision: number, document: Record<string, any>}} */
function parseFencedSnapshot(value, name) {
  const object = exactKeys(value, ['version', 'fence', 'revision', 'document'], name)
  if (object.version !== 1 || !Number.isSafeInteger(object.fence) || object.fence < 0 || !Number.isSafeInteger(object.revision) || object.revision < 0) throw new Error(`${name} header is invalid`)
  return { version: 1, fence: object.fence, revision: object.revision, document: object.document }
}

/** @param {unknown} value @returns {{version: 1, fence: number}} */
function parseFenceHighWater(value) {
  const object = exactKeys(value, ['version', 'fence'], 'Capacity registry fence high water')
  if (object.version !== 1 || !Number.isSafeInteger(object.fence) || object.fence < 0) throw new Error('Capacity registry fence high water is invalid')
  return { version: 1, fence: object.fence }
}

/** @param {string} directory @param {string} prefix @returns {Promise<string[]>} */
async function snapshotFiles(directory, prefix) {
  try {
    const names = await readdir(directory)
    return names.filter(name => new RegExp(`^${prefix}\\.[0-9]+\\.[0-9]+\\.[A-Za-z0-9-]+\\.json$`).test(name)).sort()
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return []
    throw error
  }
}

/** @param {string} path @returns {Promise<any|null>} */
async function readJsonRaceSafe(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    if (['ENOENT', 'EPERM', 'EBUSY'].includes(String(errorCode(error)))) return null
    throw error
  }
}

/** Read an immutable snapshot set, retrying enumeration when compaction races a reader. */
/** @param {string} directory @param {string} prefix @returns {Promise<any[]>} */
async function readStableSnapshots(directory, prefix) {
  for (let attempt = 0; attempt < READ_RETRIES; attempt += 1) {
    const first = await snapshotFiles(directory, prefix)
    const values = []
    let retry = false
    for (const name of first) {
      const value = await readJsonRaceSafe(join(directory, name))
      if (value === null) { retry = true; break }
      values.push({ name, value })
    }
    if (!retry) {
      const second = await snapshotFiles(directory, prefix)
      if (first.join('\n') === second.join('\n')) return values
    }
    await new Promise(resolvePromise => setTimeout(resolvePromise, 2))
  }
  throw new Error(`Capacity ${prefix} snapshots changed during every stable read attempt`)
}

/**
 * Read multiple immutable snapshot families against one compaction barrier.
 * A journal base and its events are only a valid pair when every family has
 * the same before/after directory enumeration.
 * @param {string} directory
 * @param {string[]} prefixes
 * @returns {Promise<Map<string, Array<{name: string, value: any}>>>}
 */
async function readStableSnapshotFamilies(directory, prefixes) {
  for (let attempt = 0; attempt < READ_RETRIES; attempt += 1) {
    const first = new Map()
    for (const prefix of prefixes) {
      first.set(prefix, await snapshotFiles(directory, prefix))
    }
    const values = new Map()
    let retry = false
    for (const prefix of prefixes) {
      const family = []
      for (const name of first.get(prefix) ?? []) {
        const value = await readJsonRaceSafe(join(directory, name))
        if (value === null) {
          retry = true
          break
        }
        family.push({ name, value })
      }
      values.set(prefix, family)
      if (retry) break
    }
    if (!retry) {
      let stable = true
      for (const prefix of prefixes) {
        const second = await snapshotFiles(directory, prefix)
        if ((first.get(prefix) ?? []).join('\n') !== second.join('\n')) {
          stable = false
          break
        }
      }
      if (stable) return values
    }
    await new Promise(resolvePromise => setTimeout(resolvePromise, 2))
  }
  throw new Error(`Capacity snapshot families changed during every stable read attempt`)
}

/** @param {string} path */
async function bestEffortRemove(path) {
  try {
    await rm(path, { force: true })
  } catch (error) {
    if (!['ENOENT', 'EISDIR', 'ERR_FS_EISDIR', 'EPERM', 'EBUSY'].includes(String(errorCode(error)))) throw error
  }
}

/** @param {string} directory @param {string} prefix @param {Record<string, any>} value @param {{assertOwner?: () => Promise<void>}} [options] */
async function writeSnapshot(directory, prefix, value, options = {}) {
  await mkdir(directory, { recursive: true })
  const temporary = join(directory, `${prefix}.${randomUUID()}.tmp`)
  const target = join(directory, `${prefix}.${value.fence}.${value.revision}.${randomUUID()}.json`)
  let handle
  try {
    handle = await open(temporary, 'wx')
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8')
    await handle.sync()
    await handle.close()
    handle = undefined
    await options.assertOwner?.()
    await rename(temporary, target)
  } finally {
    await handle?.close()
    await bestEffortRemove(temporary)
  }
}

/** @param {string} directory @param {string} prefix @returns {Promise<void>} */
async function compactSnapshots(directory, prefix) {
  const files = await readStableSnapshots(directory, prefix)
  if (files.length < 2) return
  const parsed = files.map(({ name, value }) => ({ name, ...parseFencedSnapshot(value, `${prefix} snapshot`) }))
  const highestFence = Math.max(...parsed.map(item => item.fence))
  const newest = parsed.filter(item => item.fence === highestFence)
    .sort((left, right) => left.revision - right.revision || left.name.localeCompare(right.name)).at(-1)
  if (!newest) return
  await Promise.all(parsed.filter(item => item.name !== newest.name).map(item => bestEffortRemove(join(directory, item.name))))
}

/** @param {string} stateRoot @returns {Promise<{document: Record<string, any>, fence: number, revision: number}>} */
async function readRegistrySnapshot(stateRoot) {
  const paths = capacityRegistryPaths(stateRoot)
  const values = await readStableSnapshots(paths.directory, paths.recordPrefix)
  const candidates = values.map(({ name, value }) => {
    const snapshot = parseFencedSnapshot(value, 'Capacity registry snapshot')
    return { ...snapshot, document: parseRegistryDocument(snapshot.document), name }
  })
  candidates.sort((left, right) => left.fence - right.fence || left.revision - right.revision || left.name.localeCompare(right.name))
  const current = candidates.at(-1)
  return current
    ? { document: current.document, fence: current.fence, revision: current.revision }
    : { document: { version: 1, records: {} }, fence: 0, revision: 0 }
}

/** Read the highest fenced registry snapshot. */
/** @param {string} stateRoot @returns {Promise<Record<string, any>>} */
export async function readCapacityRegistry(stateRoot) {
  return (await readRegistrySnapshot(stateRoot)).document
}

/** @param {string} stateRoot @param {Record<string, any>} document @param {{assertOwner?: () => Promise<void>, fence?: number}} [options] */
export async function writeCapacityRegistry(stateRoot, document, options = {}) {
  const paths = capacityRegistryPaths(stateRoot)
  const normalized = parseRegistryDocument(document)
  const current = await readRegistrySnapshot(stateRoot)
  const fence = options.fence ?? current.fence
  if (!Number.isSafeInteger(fence) || fence < current.fence) throw new Error('Capacity registry fencing token is stale')
  await writeSnapshot(paths.directory, paths.recordPrefix, {
    version: 1, fence, revision: fence === current.fence ? current.revision + 1 : 0, document: normalized,
  }, options)
  await compactSnapshots(paths.directory, paths.recordPrefix)
}

/** @param {string} stateRoot @returns {Promise<{attempts: Record<string, any>[], fence: number}>} */
async function readAttemptSnapshot(stateRoot) {
  const paths = capacityRegistryPaths(stateRoot)
  const families = await readStableSnapshotFamilies(paths.directory, [paths.attemptsBasePrefix, paths.attemptsEventPrefix])
  const bases = (families.get(paths.attemptsBasePrefix) ?? []).map(({ name, value }) => {
    const snapshot = parseFencedSnapshot(value, 'Capacity attempt base snapshot')
    const object = exactKeys(snapshot.document, ['version', 'attempts'], 'Capacity attempt journal')
    if (object.version !== 1 || !Array.isArray(object.attempts)) throw new Error('Capacity attempt journal base is invalid')
    return { ...snapshot, attempts: object.attempts.map(parseCapacityAttempt), name }
  })
  bases.sort((left, right) => left.fence - right.fence || left.revision - right.revision || left.name.localeCompare(right.name))
  const base = bases.at(-1)
  const attempts = base ? [...base.attempts] : []
  const byId = new Map(attempts.map(item => [item.attemptId, item]))
  const events = (families.get(paths.attemptsEventPrefix) ?? []).map(({ name, value }) => {
    const snapshot = parseFencedSnapshot(value, 'Capacity attempt event')
    const object = exactKeys(snapshot.document, ['version', 'attempt'], 'Capacity attempt event')
    if (object.version !== 1) throw new Error('Capacity attempt event is invalid')
    return { ...snapshot, attempt: parseCapacityAttempt(object.attempt), name }
  })
  events.sort((left, right) => left.fence - right.fence || left.revision - right.revision || left.name.localeCompare(right.name))
  for (const event of events.filter(item => !base || item.fence >= base.fence)) {
    const existing = byId.get(event.attempt.attemptId)
    if (existing) {
      if (JSON.stringify(existing) !== JSON.stringify(event.attempt)) throw new Error(`Capacity attempt ${event.attempt.attemptId} conflicts with the existing journal entry`)
      continue
    }
    attempts.push(event.attempt)
    byId.set(event.attempt.attemptId, event.attempt)
  }
  return { attempts, fence: Math.max(base?.fence ?? 0, ...events.map(event => event.fence)) }
}

/** @param {string} stateRoot @returns {Promise<Record<string, any>[]>} */
export async function readCapacityAttempts(stateRoot) {
  const attempts = (await readAttemptSnapshot(stateRoot)).attempts
  if (attempts.length > MAX_ATTEMPTS) throw new Error('Capacity attempt journal exceeds its bound')
  return attempts
}

/** @param {string} directory @param {number} fence @returns {Promise<void>} */
/** @param {string} directory @param {number} fence @param {{assertOwner?: () => Promise<void>}} [options] */
async function compactAttemptStorage(directory, fence, options = {}) {
  const bases = await readStableSnapshots(directory, 'attempt-base')
  const events = await readStableSnapshots(directory, 'attempt-event')
  const newestBase = bases.map(({ name, value }) => ({ name, ...parseFencedSnapshot(value, 'Capacity attempt base snapshot') }))
    .filter(item => item.fence === fence).sort((left, right) => left.name.localeCompare(right.name)).at(-1)
  if (!newestBase) return
  // Never remove a snapshot from a newer fencing generation. A stale
  // compactor may still finish after a new owner publishes its base.
  await options.assertOwner?.()
  await Promise.all(bases.map(({ name, value }) => {
    const snapshot = parseFencedSnapshot(value, 'Capacity attempt base snapshot')
    return snapshot.fence <= fence && name !== newestBase.name
      ? bestEffortRemove(join(directory, name))
      : undefined
  }).filter(Boolean))
  await Promise.all(events.map(({ name, value }) => {
    const event = parseFencedSnapshot(value, 'Capacity attempt event')
    return event.fence <= fence ? bestEffortRemove(join(directory, name)) : undefined
  }).filter(Boolean))
}

/** @param {string} stateRoot @param {Record<string, any>} attempt @param {{fence?: number, assertOwner?: () => Promise<void>}} [options] */
async function appendAttemptUnlocked(stateRoot, attempt, options = {}) {
  const paths = capacityRegistryPaths(stateRoot)
  const normalized = parseCapacityAttempt(attempt)
  const current = await readAttemptSnapshot(stateRoot)
  const existing = current.attempts.find(item => item.attemptId === normalized.attemptId)
  if (existing) {
    if (JSON.stringify(existing) !== JSON.stringify(normalized)) throw new Error(`Capacity attempt ${normalized.attemptId} conflicts with the existing journal entry`)
    return existing
  }
  if (current.attempts.length >= MAX_ATTEMPTS) throw new Error('Capacity attempt journal is full')
  const fence = options.fence ?? current.fence
  if (!Number.isSafeInteger(fence) || fence < current.fence) throw new Error('Capacity attempt fencing token is stale')
  await writeSnapshot(paths.directory, paths.attemptsEventPrefix, {
    version: 1, fence, revision: 0, document: { version: 1, attempt: normalized },
  }, options)
  if ((await snapshotFiles(paths.directory, paths.attemptsEventPrefix)).length >= ATTEMPT_COMPACTION_THRESHOLD) {
    await writeSnapshot(paths.directory, paths.attemptsBasePrefix, {
      version: 1, fence, revision: 0, document: { version: 1, attempts: [...current.attempts, normalized] },
    }, options)
    await compactAttemptStorage(paths.directory, fence, options)
  }
  return normalized
}

/** Atomically claim one immutable attempt identity before a Worker starts. */
/** @param {string} stateRoot @param {Record<string, any>} attempt @param {{fence?: number, assertOwner?: () => Promise<void>}} [options] @returns {Promise<{claimed: boolean, attempt: Record<string, any>}>} */
async function claimAttemptUnlocked(stateRoot, attempt, options = {}) {
  const normalized = parseCapacityAttempt(attempt)
  const current = await readAttemptSnapshot(stateRoot)
  const existing = current.attempts.find(item => item.attemptId === normalized.attemptId)
  if (existing) {
    const immutable = [
      'version', 'attemptId', 'workRequestId', 'routePolicyHash', 'taskClass', 'workerId',
      'capacityGroup', 'capacityGeneration', 'capacityGenerationHash', 'startState',
    ]
    if (immutable.some(key => existing[key] !== normalized[key])) {
      throw new Error(`Capacity attempt ${normalized.attemptId} conflicts with the existing immutable identity`)
    }
    return { claimed: false, attempt: existing }
  }
  return { claimed: true, attempt: await appendAttemptUnlocked(stateRoot, normalized, options) }
}

/** @param {string} stateRoot @param {Record<string, any>} attempt @param {{waitMs?: number, leaseMs?: number}} [options] */
export async function appendCapacityAttempt(stateRoot, attempt, options = {}) {
  const normalized = parseCapacityAttempt(attempt)
  return withCapacityRegistryLock(stateRoot, (_paths, lease) => appendAttemptUnlocked(stateRoot, normalized, lease), options)
}

/** Atomically claim one durable attempt identity. */
/** @param {string} stateRoot @param {Record<string, any>} attempt @param {{waitMs?: number, leaseMs?: number}} [options] @returns {Promise<{claimed: boolean, attempt: Record<string, any>}>} */
export async function claimCapacityAttempt(stateRoot, attempt, options = {}) {
  const normalized = parseCapacityAttempt(attempt)
  return withCapacityRegistryLock(stateRoot, (_paths, lease) => claimAttemptUnlocked(stateRoot, normalized, lease), options)
}

/** @param {unknown} value @returns {{version: 1, ownerToken: string, fence: number, acquiredAt: string, expiresAt: string, pid?: number, processIdentity?: string}} */
function parseLease(value) {
  const object = exactKeys(value, ['version', 'ownerToken', 'fence', 'acquiredAt', 'expiresAt', 'pid', 'processIdentity'], 'Capacity registry lease')
  if (object.version !== 1) throw new Error('Capacity registry lease version must be 1')
  const acquiredAt = timestamp(object.acquiredAt, 'Capacity registry lease acquiredAt')
  const expiresAt = timestamp(object.expiresAt, 'Capacity registry lease expiresAt')
  if (Date.parse(expiresAt) <= Date.parse(acquiredAt)) throw new Error('Capacity registry lease expiresAt must follow acquiredAt')
  if (!Number.isSafeInteger(object.fence) || object.fence < 0) throw new Error('Capacity registry lease fence must be a non-negative integer')
  if (object.pid !== undefined && (!Number.isSafeInteger(object.pid) || object.pid < 1)) throw new Error('Capacity registry lease pid must be a positive integer')
  if (object.pid === undefined && object.processIdentity !== undefined) throw new Error('Capacity registry lease process identity requires pid')
  if (object.processIdentity !== undefined && (typeof object.processIdentity !== 'string' || object.processIdentity.length < 1 || object.processIdentity.length > 512)) throw new Error('Capacity registry lease processIdentity is invalid')
  return {
    version: 1,
    ownerToken: identifier(object.ownerToken, 'Capacity registry lease ownerToken'),
    fence: object.fence,
    acquiredAt,
    expiresAt,
    ...(object.pid === undefined ? {} : { pid: object.pid, processIdentity: object.processIdentity }),
  }
}

/**
 * Read one lease file while a concurrent writer is publishing it. A malformed
 * document is retried briefly for compatibility with older lease files; an
 * unrecoverable malformed document fails closed rather than being treated as
 * an available lock.
 * @param {string} path
 * @returns {Promise<ReturnType<typeof parseLease>|null>}
 */
async function readLeaseFile(path) {
  for (let attempt = 0; attempt < READ_RETRIES; attempt += 1) {
    try {
      return parseLease(JSON.parse(await readFile(path, 'utf8')))
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return null
      const retryable = ['EPERM', 'EBUSY'].includes(String(errorCode(error))) || error instanceof SyntaxError
      if (!retryable || attempt === READ_RETRIES - 1) throw error
      await new Promise(resolvePromise => setTimeout(resolvePromise, 2))
    }
  }
  return null
}

/** @param {string} directory @param {string} prefix @returns {Promise<string[]>} */
async function legacyLeaseFiles(directory, prefix) {
  try {
    return (await readdir(directory))
      .filter(name => name.startsWith(`${prefix}.`) && name.endsWith('.json'))
      .sort()
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return []
    throw error
  }
}

/**
 * Remove only expired owner-addressed leases left by the pre-canonical gate.
 * The canonical owner and fencing token are required so an active or newer
 * lease cannot be mistaken for stale residue. Work is deliberately bounded;
 * later successful operations finish a large backlog incrementally.
 * @param {ReturnType<typeof capacityRegistryPaths>} paths
 * @param {string} prefix
 * @param {string} ownerToken
 * @param {number} fence
 * @param {number} now
 * @param {ProcessIdentityVerifier} verifier
 * @returns {Promise<void>}
 */
async function cleanupStaleLeaseFiles(paths, prefix, ownerToken, fence, now, verifier) {
  let removed = 0
  for (const name of await legacyLeaseFiles(paths.directory, prefix)) {
    if (removed >= STALE_LEASE_CLEANUP_LIMIT) break
    const expectedOwner = name.slice(`${prefix}.`.length, -'.json'.length)
    let lease
    try {
      lease = await readLeaseFile(join(paths.directory, name))
    } catch {
      // A malformed residue is not safe to classify as stale. Leave it for
      // explicit repair rather than making cleanup a destructive parser.
      continue
    }
    if (!lease || lease.ownerToken !== expectedOwner) continue
    if (lease.ownerToken === ownerToken && lease.fence === fence) continue
    if (lease.fence >= fence || await leaseIsHeld(lease, () => now, verifier)) continue
    await bestEffortRemove(join(paths.directory, name))
    removed += 1
  }
}

/** @param {ReturnType<typeof capacityRegistryPaths>} paths @param {string} ownerToken @param {number} fence @param {number} now @param {ProcessIdentityVerifier} verifier */
async function cleanupStaleLegacyLeases(paths, ownerToken, fence, now, verifier) {
  await cleanupStaleLeaseFiles(paths, paths.leasePrefix, ownerToken, fence, now, verifier)
}

/** @param {string} directory @param {string} snapshotPrefix @param {ReturnType<typeof capacityRegistryPaths>} paths @returns {Promise<number>} */
async function highestFence(directory, snapshotPrefix, paths) {
  const files = await snapshotFiles(directory, snapshotPrefix)
  let highest = 0
  const highWater = await readJsonRaceSafe(paths.fencePath)
  if (highWater !== null) highest = Math.max(highest, parseFenceHighWater(highWater).fence)
  for (const name of files) {
    const value = await readJsonRaceSafe(join(directory, name))
    if (value === null) continue
    highest = Math.max(highest, parseFencedSnapshot(value, `${snapshotPrefix} snapshot`).fence)
  }
  for (const leasePath of [paths.lockPath, paths.reclaimPath]) {
    const info = await pathStats(leasePath)
    if (!info) continue
    if (!info.isDirectory()) {
      const lease = await readLeaseFile(leasePath)
      if (lease) highest = Math.max(highest, lease.fence)
      continue
    }
    for (const name of await gateOwnerFiles(leasePath)) {
      const lease = await readLeaseFile(join(leasePath, name))
      if (lease) highest = Math.max(highest, lease.fence)
    }
  }
  for (const name of await legacyLeaseFiles(directory, paths.leasePrefix)) {
    const lease = await readLeaseFile(join(directory, name))
    if (lease) highest = Math.max(highest, lease.fence)
  }
  return highest
}

/** Publish an owner-scoped lease snapshot without making it an acquisition gate. */
/** @param {string} directory @param {string} path @param {ReturnType<typeof parseLease>} lease */
async function publishPrivateLease(directory, path, lease) {
  await mkdir(directory, { recursive: true })
  const temporary = `${path}.${randomUUID()}.tmp`
  let handle
  try {
    handle = await open(temporary, 'wx')
    await handle.writeFile(`${JSON.stringify(lease)}\n`, 'utf8')
    await handle.sync()
    await handle.close()
    handle = undefined
    await rename(temporary, path)
  } finally {
    await handle?.close()
    await bestEffortRemove(temporary)
  }
}

/** @param {string} path @param {number} fence */
async function publishFenceHighWater(path, fence) {
  const currentValue = await readJsonRaceSafe(path)
  if (currentValue !== null) {
    const current = parseFenceHighWater(currentValue)
    if (current.fence >= fence) return current.fence
  }
  const temporary = `${path}.${randomUUID()}.tmp`
  let handle
  try {
    handle = await open(temporary, 'wx')
    await handle.writeFile(`${JSON.stringify({ version: 1, fence })}\n`, 'utf8')
    await handle.sync()
    await handle.close()
    handle = undefined
    await rename(temporary, path)
    return fence
  } finally {
    await handle?.close()
    await bestEffortRemove(temporary)
  }
}

/** @param {ReturnType<typeof capacityRegistryPaths>} paths @param {ReturnType<typeof parseLease>} lease @returns {Promise<ReturnType<typeof parseLease>>} */
async function reserveLeaseFence(paths, lease) {
  let candidate = lease
  for (let attempt = 0; attempt < READ_RETRIES; attempt += 1) {
    const currentValue = await readJsonRaceSafe(paths.fencePath)
    const current = currentValue === null ? 0 : parseFenceHighWater(currentValue).fence
    const fence = Math.max(candidate.fence, current + 1)
    const reserved = fence === candidate.fence ? candidate : parseLease({ ...candidate, fence })
    const published = await publishFenceHighWater(paths.fencePath, fence)
    if (published <= fence) return reserved
    candidate = parseLease({ ...reserved, fence: published + 1 })
  }
  throw new Error('Capacity registry fence high water changed during every reservation attempt')
}

/** @typedef {(pid: number) => Promise<string|null>} ProcessIdentityVerifier */
/** @typedef {{waitMs?: number, leaseMs?: number, now?: number|(() => number), processIdentity?: ProcessIdentityVerifier}} RegistryLockOptions */

/** @param {RegistryLockOptions} options @returns {() => number} */
function lockClock(options) {
  const configured = options.now
  if (typeof configured === 'function') return configured
  if (configured !== undefined) return () => configured
  return () => Date.now()
}

/** @param {number} milliseconds */
async function waitForLock(milliseconds) {
  await new Promise(resolvePromise => setTimeout(resolvePromise, milliseconds))
}

/** @typedef {{platform?: NodeJS.Platform, readFile?: typeof readFile, runCommand?: typeof run, psPath?: string, powershellPath?: string}} ProcessIdentityOptions */

/** @param {unknown} error @param {number} code @returns {boolean} */
function commandExitedWith(error, code) {
  const numericCode = error && typeof error === 'object' ? /** @type {{code?: unknown}} */ (error).code : undefined
  return numericCode === code || error instanceof Error && new RegExp(`exited with code ${code}(?::|$)`).test(error.message)
}

/** @param {string} command @param {string[]} args @param {typeof run} runCommand @returns {Promise<{stdout: string}>} */
async function runProcessProbe(command, args, runCommand) {
  const controller = new AbortController()
  let timer
  const commandPromise = Promise.resolve().then(() => runCommand(command, args, {
    signal: controller.signal,
    timeoutMs: PROCESS_IDENTITY_TIMEOUT_MS,
    maxOutputBytes: 64 * 1024,
  }))
  const timeoutPromise = new Promise(resolvePromise => {
    timer = setTimeout(() => {
      controller.abort()
      resolvePromise({ type: 'timeout' })
    }, PROCESS_IDENTITY_TIMEOUT_MS)
  })
  try {
    const outcome = await Promise.race([
      commandPromise.then(value => ({ type: 'result', value }), error => ({ type: 'error', error })),
      timeoutPromise,
    ])
    if (outcome.type === 'result') return outcome.value
    if (outcome.type === 'error') throw outcome.error
    if (runCommand !== run) {
      const settled = await Promise.race([
        commandPromise.then(() => true, () => true),
        new Promise(resolvePromise => setTimeout(() => resolvePromise(false), PROCESS_IDENTITY_TERMINATION_GRACE_MS)),
      ])
      if (!settled) throw new Error('Process identity probe runner did not settle after abort')
    }
    try {
      await commandPromise
    } catch (error) {
      throw new Error(`Process identity probe timed out after ${PROCESS_IDENTITY_TIMEOUT_MS} ms`, { cause: error })
    }
    throw new Error(`Process identity probe timed out after ${PROCESS_IDENTITY_TIMEOUT_MS} ms`)
  } finally {
    clearTimeout(timer)
  }
}

/** @param {string} command @param {string[]} args @returns {Promise<{stdout: string}>} */
async function runWindowsProcessProbe(command, args) {
  return new Promise((resolvePromise, reject) => {
    execFile(command, args, {
      windowsHide: true,
      timeout: PROCESS_IDENTITY_TIMEOUT_MS,
      maxBuffer: 64 * 1024,
    }, (error, stdout) => {
      if (error) {
        reject(error)
        return
      }
      resolvePromise({ stdout })
    })
  })
}

/** @param {ProcessIdentityVerifier} verifier @param {number} pid @returns {Promise<string|null>} */
async function boundedProcessIdentity(verifier, pid) {
  let timer
  const identityPromise = Promise.resolve().then(() => verifier(pid))
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Process identity probe timed out after ${PROCESS_IDENTITY_TIMEOUT_MS} ms`)), PROCESS_IDENTITY_TIMEOUT_MS)
  })
  try {
    return await Promise.race([identityPromise, timeoutPromise])
  } finally {
    clearTimeout(timer)
  }
}

/** @returns {Promise<string>} */
async function defaultPowerShellPath() {
  const candidates = []
  for (const programFiles of [process.env.ProgramW6432, process.env.ProgramFiles]) {
    if (programFiles && isAbsolute(programFiles)) candidates.push(join(programFiles, 'PowerShell', '7', 'pwsh.exe'))
  }
  const systemRoot = process.env.SystemRoot
  if (systemRoot && isAbsolute(systemRoot)) candidates.push(join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'))
  for (const candidate of candidates) {
    try {
      await access(candidate)
      return candidate
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error
    }
  }
  throw new Error('Windows process identity requires a trusted absolute PowerShell executable')
}

/**
 * Read an OS process-start identity. Linux uses the boot id and `/proc` start
 * ticks; macOS uses the locale-neutral `ps` start time; Windows uses the
 * Operations `Process.StartTime` verifier. Only a clearly absent target PID
 * returns null; command, filesystem, timeout, and parse failures throw.
 * @param {number} pid
 * @param {ProcessIdentityOptions} [options]
 * @returns {Promise<string|null>}
 */
export async function resolveProcessIdentity(pid, options = {}) {
  if (!Number.isSafeInteger(pid) || pid < 1) return null
  const platform = options.platform ?? process.platform
  const read = options.readFile ?? readFile
  const runCommand = options.runCommand ?? run
  if (platform === 'linux') {
    let stat
    try {
      stat = await read(`/proc/${pid}/stat`, 'utf8')
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return null
      throw error
    }
    const close = stat.lastIndexOf(')')
    if (close < 0) throw new Error('Linux process stat is malformed')
    const fields = stat.slice(close + 2).trim().split(/\s+/)
    const startTicks = fields[19]
    if (!startTicks) throw new Error('Linux process stat has no start time')
    const bootId = (await read('/proc/sys/kernel/random/boot_id', 'utf8')).trim()
    if (!bootId) throw new Error('Linux process boot identity is empty')
    return `linux:${bootId}:${startTicks}`
  }
  if (platform === 'darwin') {
    const command = options.psPath ?? '/bin/ps'
    let result
    try {
      result = await runProcessProbe(command, ['-p', String(pid), '-o', 'lstart='], runCommand)
    } catch (error) {
      if (commandExitedWith(error, 1)) return null
      throw error
    }
    const value = result.stdout.trim()
    if (!value) throw new Error('macOS process identity output is empty')
    const parsed = Date.parse(value)
    if (!Number.isFinite(parsed)) throw new Error('macOS process start time is invalid')
    return `darwin:${new Date(parsed).toISOString()}`
  }
  if (platform === 'win32') {
    const command = `$process = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if ($null -eq $process) { exit 3 }; $process.StartTime.ToUniversalTime().ToString('o')`
    const executable = options.powershellPath ?? await defaultPowerShellPath()
    let result
    try {
      const args = ['-NoProfile', '-NonInteractive', '-Command', command]
      result = options.runCommand === undefined
        ? await runWindowsProcessProbe(executable, args)
        : await runProcessProbe(executable, args, runCommand)
    } catch (error) {
      if (commandExitedWith(error, 3)) return null
      throw error
    }
    const value = result.stdout.trim()
    if (!value) throw new Error('Windows process identity output is empty')
    return `windows:${value}`
  }
  throw new Error(`Unsupported platform for process identity verification: ${platform}`)
}

/** @param {number} pid @returns {Promise<string|null>} */
async function processIdentity(pid) {
  return resolveProcessIdentity(pid)
}

let localProcessIdentityPromise

/** @returns {Promise<string>} */
async function localProcessIdentity() {
  localProcessIdentityPromise ??= processIdentity(process.pid).then(identity => {
    if (!identity) throw new Error('Current process identity could not be verified')
    return identity
  })
  return localProcessIdentityPromise
}

/** @param {ReturnType<typeof parseLease>} lease @param {() => number} clock @param {ProcessIdentityVerifier} verifier @returns {Promise<boolean>} */
async function leaseIsHeld(lease, clock, verifier) {
  if (Date.parse(lease.expiresAt) > clock()) return true
  if (lease.pid === undefined || lease.processIdentity === undefined) return false
  const identity = await verifier(lease.pid)
  return identity !== null && identity === lease.processIdentity
}

/** @param {string} gatePath @param {string} ownerToken @returns {string} */
function gateOwnerPath(gatePath, ownerToken) {
  return join(gatePath, `${GATE_OWNER_PREFIX}.${ownerToken}.json`)
}

/** @param {string} path @returns {Promise<string[]>} */
async function gateOwnerFiles(path) {
  try {
    return (await readdir(path)).filter(name => GATE_OWNER_FILE_PATTERN.test(name)).sort()
  } catch (error) {
    if (['ENOENT', 'EPERM', 'EBUSY'].includes(String(errorCode(error)))) return []
    throw error
  }
}

/** @param {string} path @returns {Promise<ReturnType<typeof lstat>|null>} */
async function pathStats(path) {
  try {
    return await lstat(path)
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return null
    throw error
  }
}

/** @param {string} path */
async function bestEffortRemoveTree(path) {
  try {
    await rm(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 2 })
  } catch (error) {
    if (!['ENOENT', 'EISDIR', 'EPERM', 'EBUSY'].includes(String(errorCode(error)))) throw error
  }
}

/** @param {string} path @param {() => number} clock @param {ProcessIdentityVerifier} verifier */
async function removeStaleReclaim(path, clock, verifier) {
  for (const name of await gateOwnerFiles(path)) {
    const ownerPath = join(path, name)
    const lease = await readLeaseFile(ownerPath)
    if (lease && await leaseIsHeld(lease, clock, verifier)) continue
    await bestEffortRemove(ownerPath)
  }
  await bestEffortRemoveEmptyDirectory(path)
}

/** @param {string} path */
async function bestEffortRemoveEmptyDirectory(path) {
  try {
    await rmdir(path)
  } catch (error) {
    if (!['ENOENT', 'ENOTEMPTY', 'EPERM', 'EBUSY'].includes(String(errorCode(error)))) throw error
  }
}

/** @param {string} path @param {() => number} clock @param {ProcessIdentityVerifier} verifier @returns {Promise<{state: 'absent'|'held'|'stale', lease?: ReturnType<typeof parseLease>}>} */
async function readReclaimState(path, clock, verifier) {
  let pendingLease = false
  for (const name of await legacyLeaseFiles(dirname(path), RECLAIM_PENDING_PREFIX)) {
    const lease = await readLeaseFile(join(dirname(path), name))
    if (lease && await leaseIsHeld(lease, clock, verifier)) return { state: 'held', lease }
    pendingLease = true
  }
  const info = await pathStats(path)
  if (!info) return pendingLease ? { state: 'stale' } : { state: 'absent' }
  if (!info.isDirectory()) {
    const lease = await readLeaseFile(path)
    if (lease && await leaseIsHeld(lease, clock, verifier)) return { state: 'held', lease }
    return lease ? { state: 'stale', lease } : { state: 'stale' }
  }
  const names = await gateOwnerFiles(path)
  for (const name of names) {
    const lease = await readLeaseFile(join(path, name))
    if (lease && await leaseIsHeld(lease, clock, verifier)) return { state: 'held', lease }
  }
  return pendingLease ? { state: 'stale' } : { state: 'stale' }
}

/** @param {ReturnType<typeof capacityRegistryPaths>} paths @param {string} gatePath @param {() => number} clock @param {ProcessIdentityVerifier} verifier @returns {Promise<{state: 'absent'|'held'|'stale', lease?: ReturnType<typeof parseLease>}>} */
async function readGateState(paths, gatePath, clock, verifier) {
  let pendingLease = false
  for (const name of await legacyLeaseFiles(paths.directory, paths.leasePrefix)) {
    let lease
    try { lease = await readLeaseFile(join(paths.directory, name)) } catch (error) {
      throw error
    }
    // Only the current protocol's PID-bearing candidate is an acquisition
    // intent. Older owner-addressed leases remain cleanup candidates and must
    // not block a fresh canonical gate.
    if (lease?.pid === undefined) continue
    if (await leaseIsHeld(lease, clock, verifier)) return { state: 'held', lease }
    pendingLease = true
  }
  const info = await pathStats(gatePath)
  if (!info) return pendingLease ? { state: 'stale' } : { state: 'absent' }
  if (!info.isDirectory()) {
    const lease = await readLeaseFile(gatePath)
    if (lease && await leaseIsHeld(lease, clock, verifier)) return { state: 'held', lease }
    return lease ? { state: 'stale', lease } : { state: 'stale' }
  }
  const names = await gateOwnerFiles(gatePath)
  if (names.length > 1) throw new Error('Capacity registry gate has multiple owners')
  if (names.length === 1) {
    const lease = await readLeaseFile(join(gatePath, names[0]))
    if (lease && await leaseIsHeld(lease, clock, verifier)) return { state: 'held', lease }
    return lease ? { state: 'stale', lease } : { state: 'stale' }
  }
  return { state: 'stale' }
}

/** @param {ReturnType<typeof capacityRegistryPaths>} paths @param {string} ownerToken @param {number} fence @param {() => number} clock @param {ProcessIdentityVerifier} verifier */
async function assertLeaseOwner(paths, ownerToken, fence, clock, verifier) {
  const current = await readLeaseFile(gateOwnerPath(paths.lockPath, ownerToken))
  if (!current || current.ownerToken !== ownerToken || current.fence !== fence || !(await leaseIsHeld(current, clock, verifier))) {
    throw new Error('Capacity registry lease ownership was lost')
  }
}

/** @param {string} markerPath @param {string} ownerToken @param {number} fence @param {() => number} clock @param {ProcessIdentityVerifier} verifier */
async function assertReclaimOwner(markerPath, ownerToken, fence, clock, verifier) {
  const current = await readLeaseFile(gateOwnerPath(markerPath, ownerToken))
  if (!current || current.ownerToken !== ownerToken || current.fence !== fence || !(await leaseIsHeld(current, clock, verifier))) {
    throw new Error('Capacity registry reclaim ownership was lost')
  }
}

/** @param {ReturnType<typeof capacityRegistryPaths>} paths @param {string} ownerToken @param {number} fence */
async function releaseLease(paths, ownerToken, fence) {
  const markerPath = gateOwnerPath(paths.lockPath, ownerToken)
  const current = await readLeaseFile(markerPath)
  if (current?.ownerToken === ownerToken && current.fence === fence) await bestEffortRemove(markerPath)
  await bestEffortRemoveEmptyDirectory(paths.lockPath)
  const candidatePath = join(paths.directory, `${paths.leasePrefix}.${ownerToken}.json`)
  const candidate = await readLeaseFile(candidatePath)
  if (candidate?.ownerToken === ownerToken && candidate.fence === fence) await bestEffortRemove(candidatePath)
}

/** @param {string} markerPath @param {string} ownerToken @param {number} fence */
async function releaseReclaim(markerPath, ownerToken, fence) {
  const current = await readLeaseFile(gateOwnerPath(markerPath, ownerToken))
  if (current?.ownerToken !== ownerToken || current.fence !== fence) return
  await bestEffortRemove(gateOwnerPath(markerPath, ownerToken))
  await bestEffortRemoveEmptyDirectory(markerPath)
}

/** @param {ReturnType<typeof capacityRegistryPaths>} paths @param {() => number} clock @param {number} leaseMs @param {number} deadline @param {ProcessIdentityVerifier} verifier @returns {Promise<ReturnType<typeof parseLease>|null>} */
async function claimReclaimMarker(paths, clock, leaseMs, deadline, verifier) {
  let firstAttempt = true
  while (firstAttempt || Date.now() < deadline) {
    firstAttempt = false
    const state = await readReclaimState(paths.reclaimPath, clock, verifier)
    if (state.state === 'held') return null
    if (state.state === 'stale') {
      const info = await pathStats(paths.reclaimPath)
      if (info?.isDirectory()) await removeStaleReclaim(paths.reclaimPath, clock, verifier)
      else await bestEffortRemove(paths.reclaimPath)
      await cleanupStaleLeaseFiles(paths, RECLAIM_PENDING_PREFIX, '', Number.MAX_SAFE_INTEGER, clock(), verifier)
      continue
    }
    const ownerToken = randomUUID()
    const fence = Math.max(
      clock(),
      await highestFence(paths.directory, paths.recordPrefix, paths),
      await highestFence(paths.directory, paths.attemptsEventPrefix, paths),
      await highestFence(paths.directory, paths.attemptsBasePrefix, paths),
    ) + 1
    const nowMs = clock()
    let lease = parseLease({ version: 1, ownerToken, fence, pid: process.pid, processIdentity: await localProcessIdentity(), acquiredAt: new Date(nowMs).toISOString(), expiresAt: new Date(nowMs + leaseMs).toISOString() })
    const pendingPath = join(paths.directory, `${RECLAIM_PENDING_PREFIX}.${ownerToken}.json`)
    try {
      await publishPrivateLease(paths.directory, pendingPath, lease)
      await mkdir(paths.reclaimPath)
      lease = await reserveLeaseFence(paths, lease)
      await publishPrivateLease(paths.reclaimPath, gateOwnerPath(paths.reclaimPath, ownerToken), lease)
      await bestEffortRemove(pendingPath)
      return lease
    } catch (error) {
      await bestEffortRemove(pendingPath)
      if (!['EEXIST', 'ENOENT', 'EPERM', 'EBUSY'].includes(String(errorCode(error)))) throw error
    }
  }
  return null
}

/** @param {ReturnType<typeof capacityRegistryPaths>} paths @param {() => number} clock @param {number} leaseMs @param {number} deadline @param {ProcessIdentityVerifier} verifier @returns {Promise<ReturnType<typeof parseLease>|null>} */
async function acquireCanonicalLease(paths, clock, leaseMs, deadline, verifier) {
  let firstAttempt = true
  while (firstAttempt || Date.now() < deadline) {
    firstAttempt = false
    const observed = await readGateState(paths, paths.lockPath, clock, verifier)
    if (observed.state === 'held') {
      await waitForLock(10)
      continue
    }
    const reclaim = observed.state === 'stale' ? await claimReclaimMarker(paths, clock, leaseMs, deadline, verifier) : null
    if (observed.state === 'stale' && !reclaim) {
      await waitForLock(10)
      continue
    }
    if (reclaim) {
      try {
        await assertReclaimOwner(paths.reclaimPath, reclaim.ownerToken, reclaim.fence, clock, verifier)
        await cleanupStaleLegacyLeases(paths, reclaim.ownerToken, reclaim.fence, clock(), verifier)
        const current = await readGateState(paths, paths.lockPath, clock, verifier)
        if (current.state === 'held') {
          await releaseReclaim(paths.reclaimPath, reclaim.ownerToken, reclaim.fence)
          await waitForLock(10)
          continue
        }
        const quarantine = await readGateState(paths, paths.quarantinePath, clock, verifier)
        if (quarantine.state === 'held') {
          await releaseReclaim(paths.reclaimPath, reclaim.ownerToken, reclaim.fence)
          await waitForLock(10)
          continue
        }
        if (current.state !== 'absent') {
          await bestEffortRemoveTree(paths.quarantinePath)
          await rename(paths.lockPath, paths.quarantinePath)
        }
        await bestEffortRemoveTree(paths.quarantinePath)
        await releaseReclaim(paths.reclaimPath, reclaim.ownerToken, reclaim.fence)
        continue
      } catch (error) {
        await releaseReclaim(paths.reclaimPath, reclaim.ownerToken, reclaim.fence)
        if (['EEXIST', 'ENOENT', 'EPERM', 'EBUSY'].includes(String(errorCode(error)))) continue
        throw error
      }
    }
    const ownerToken = randomUUID()
    const fence = Math.max(
      clock(),
      await highestFence(paths.directory, paths.recordPrefix, paths),
      await highestFence(paths.directory, paths.attemptsEventPrefix, paths),
      await highestFence(paths.directory, paths.attemptsBasePrefix, paths),
    ) + 1
    const nowMs = clock()
    let lease = parseLease({ version: 1, ownerToken, fence, pid: process.pid, processIdentity: await localProcessIdentity(), acquiredAt: new Date(nowMs).toISOString(), expiresAt: new Date(nowMs + leaseMs).toISOString() })
    const candidatePath = join(paths.directory, `${paths.leasePrefix}.${ownerToken}.json`)
    try {
      await publishPrivateLease(paths.directory, candidatePath, lease)
      await mkdir(paths.lockPath)
      lease = await reserveLeaseFence(paths, lease)
      await publishPrivateLease(paths.lockPath, gateOwnerPath(paths.lockPath, ownerToken), lease)
      await bestEffortRemove(candidatePath)
      return lease
    } catch (error) {
      await bestEffortRemove(candidatePath)
      if (!['EEXIST', 'EPERM', 'EBUSY'].includes(String(errorCode(error)))) throw error
    }
  }
  return null
}

/** Execute one mutation under a canonical, fenced lease. The operation is never replayed by the lock layer. */
/** @param {string} stateRoot @param {(paths: ReturnType<typeof capacityRegistryPaths>, lease: {ownerToken: string, fence: number, assertOwner: () => Promise<void>}) => Promise<any>} operation @param {RegistryLockOptions} [options] */
export async function withCapacityRegistryLock(stateRoot, operation, options = {}) {
  const paths = capacityRegistryPaths(stateRoot)
  await mkdir(paths.directory, { recursive: true })
  const waitMs = options.waitMs ?? DEFAULT_LOCK_WAIT_MS
  const leaseMs = options.leaseMs ?? DEFAULT_LOCK_LEASE_MS
  if (!Number.isSafeInteger(waitMs) || waitMs < 0 || waitMs > MAX_LOCK_WAIT_MS) throw new Error('capacity lock waitMs is out of bounds')
  if (!Number.isSafeInteger(leaseMs) || leaseMs < MIN_LOCK_LEASE_MS || leaseMs > MAX_LOCK_LEASE_MS) throw new Error('capacity lock leaseMs is out of bounds')
  const clock = lockClock(options)
  const injectedVerifier = options.processIdentity
  const verifier = injectedVerifier === undefined
    ? processIdentity
    : /** @type {ProcessIdentityVerifier} */ (pid => boundedProcessIdentity(injectedVerifier, pid))
  const deadline = Date.now() + waitMs
  const acquired = await acquireCanonicalLease(paths, clock, leaseMs, deadline, verifier)
  if (!acquired) throw new Error('Capacity registry lock is busy')
  const ownerPath = join(paths.directory, `${paths.leasePrefix}.${acquired.ownerToken}.json`)
  try {
    await cleanupStaleLegacyLeases(paths, acquired.ownerToken, acquired.fence, clock(), verifier)
    const assertOwner = () => assertLeaseOwner(paths, acquired.ownerToken, acquired.fence, clock, verifier)
    const result = await operation(paths, { ownerToken: acquired.ownerToken, fence: acquired.fence, assertOwner })
    await assertOwner()
    return result
  } finally {
    await releaseLease(paths, acquired.ownerToken, acquired.fence)
    await bestEffortRemove(ownerPath)
  }
}

/** Build a state-root-bound registry facade from trusted Worker snapshots. */
/** @param {RegistryOptions} input */
export function createCapacityRegistry({ stateRoot, configurationHash, credentialGeneration, workers = {}, now }) {
  capacityRegistryPaths(stateRoot)
  digest(configurationHash, 'configurationHash')
  identifier(credentialGeneration, 'credentialGeneration')
  if (!workers || typeof workers !== 'object' || Array.isArray(workers)) throw new Error('workers must be an object')
  const snapshots = new Map(Object.entries(workers).map(([workerId, worker]) => [workerId, {
    capacityGroup: IDENTIFIER.test(workerId) && worker.capacityGroup === undefined ? workerId : worker.capacityGroup,
    identity: projectWorkerCapacityIdentity(workerId, worker),
  }]))
  for (const [workerId, snapshot] of snapshots) identifier(snapshot.capacityGroup, `workers.${workerId}.capacityGroup`)
  /** @param {unknown} value @returns {{workerId: string, capacityGroup: string, identity: CapacityIdentity}} */
  function workerSnapshot(value) {
    const raw = typeof value === 'string' ? value : ''
    const direct = snapshots.get(raw)
    if (direct) return { workerId: raw, ...direct }
    throw new Error(`Unknown capacity Worker ${raw}`)
  }
  /** @param {Record<string, any>} document @param {string} workerId @param {number} nowMs */
  function workerScopeDecision(document, workerId, nowMs) {
    const snapshot = workerSnapshot(workerId)
    const entries = []
    let blocked = null
    for (const scope of ['capacity-group', 'provider', 'model', 'worker']) {
      if (scope === 'provider' && snapshot.identity.provider === null) continue
      if (scope === 'model' && (snapshot.identity.provider === null || snapshot.identity.model === null)) continue
      const key = capacityRecordKey({ capacityGroup: snapshot.capacityGroup, scope, identity: snapshot.identity })
      const current = document.records[key]
      if (!current) continue
      const refreshed = invalidateCapacityRecord(current, { ...identity, now: nowMs })
      const decision = capacityEligibility(refreshed, { now: nowMs })
      const entry = {
        key,
        scope,
        record: decision.record,
        requiresProbe: decision.requiresProbe === true,
        identity: decision.record.capacityIdentity,
      }
      entries.push(entry)
      if (!decision.eligible && !blocked) blocked = decision.state
    }
    const due = entries.filter(entry => entry.requiresProbe)
    return {
      snapshot,
      entries,
      due,
      eligible: blocked === null,
      startState: blocked ?? (due.length ? 'half-open' : 'available'),
      capacityGeneration: entries.reduce((highest, entry) => Math.max(highest, entry.record.generation), 0),
    }
  }

  /** @param {string} workerId @param {number} nowMs */
  async function inspectWorkerScopes(workerId, nowMs) {
    const snapshot = await readRegistrySnapshot(stateRoot)
    return workerScopeDecision(snapshot.document, workerId, nowMs)
  }

  /** @param {Record<string, any>} probe @param {Record<string, any>} snapshot @param {string} scope @param {string} key */
  function assertProbeIdentity(probe, snapshot, scope, key) {
    const expectedIdentity = scopeCapacityIdentity(scope, snapshot.identity)
    const expectedKey = capacityRecordKey({ capacityGroup: snapshot.capacityGroup, scope, identity: expectedIdentity })
    if (probe.key !== expectedKey || probe.scope !== scope || JSON.stringify(probe.identity) !== JSON.stringify(expectedIdentity)) {
      throw new Error('Capacity probe identity does not match the trusted Worker snapshot')
    }
    if (probe.leaseId === undefined) throw new Error('Capacity probe leaseId is required')
    identifier(probe.leaseId, 'capacity probe leaseId')
  }
  const identity = { configurationHash, credentialGeneration }
  const clock = typeof now === 'function' ? now : now === undefined ? () => Date.now() : () => now
  return {
    async records() {
      return withCapacityRegistryLock(stateRoot, async (_paths, lease) => {
        const document = await readRegistrySnapshot(stateRoot)
        let changed = false
        for (const [key, record] of Object.entries(document.document.records)) {
          const next = invalidateCapacityRecord(record, { ...identity, now: clock() })
          document.document.records[key] = next
          changed ||= JSON.stringify(next) !== JSON.stringify(record)
        }
        if (changed) await writeCapacityRegistry(stateRoot, document.document, lease)
        return document.document.records
      }, { now: clock })
    },
    /** @param {string} key */
    async get(key) {
      identifier(key, 'capacity registry key')
      return (await this.records())[key] ?? null
    },
    /** Inspect every applicable scope for one trusted Worker without claiming a probe. */
    /** @param {{workerId: string, now?: number}} input */
    async inspect({ workerId, now: inspectionTime }) {
      const decision = await inspectWorkerScopes(workerId, inspectionTime ?? clock())
      return {
        workerId,
        capacityGroup: decision.snapshot.capacityGroup,
        identity: decision.snapshot.identity,
        eligible: decision.eligible,
        startState: decision.startState,
        capacityGeneration: decision.capacityGeneration,
        records: decision.entries,
        probeScopes: decision.due.map(entry => entry.scope),
      }
    },
    /** @param {RegistryFailureInput} input */
    async recordFailure({ key, capacityGroup, scope, sourceWorker, failure, now: observationTime, cooldownMs }) {
      const normalizedFailure = parseAdapterFailure(failure)
      if (scope !== undefined && scope !== normalizedFailure.scope) throw new Error(`Caller scope ${scope} does not match structured failure scope ${normalizedFailure.scope}`)
      const snapshot = workerSnapshot(sourceWorker)
      if (capacityGroup !== snapshot.capacityGroup) throw new Error(`Caller capacityGroup does not match the trusted Worker snapshot ${snapshot.workerId}`)
      const recordKey = capacityRecordKey({ capacityGroup: snapshot.capacityGroup, scope: normalizedFailure.scope, identity: snapshot.identity })
      if (key !== undefined && key !== recordKey) throw new Error(`Caller key ${key} does not match the trusted identity key`)
      return withCapacityRegistryLock(stateRoot, async (_paths, lease) => {
        const document = await readRegistrySnapshot(stateRoot)
        let current = document.document.records[recordKey]
        if (!current) current = createCapacityRecord({ ...identity, capacityGroup: snapshot.capacityGroup, scope: normalizedFailure.scope, sourceWorker: snapshot.workerId, capacityIdentity: snapshot.identity, now: observationTime ?? clock() })
        document.document.records[recordKey] = recordCapacityFailure(current, normalizedFailure, { sourceWorker: snapshot.workerId, capacityIdentity: snapshot.identity, now: observationTime ?? clock(), cooldownMs })
        await writeCapacityRegistry(stateRoot, document.document, lease)
        return document.document.records[recordKey]
      }, { now: clock })
    },
    /** @param {RegistryLeaseInput} input */
    async acquireHalfOpenLease({ key, leaseId, owner, now: leaseTime, leaseMs }) {
      identifier(key, 'capacity registry key')
      return withCapacityRegistryLock(stateRoot, async (_paths, lease) => {
        const document = await readRegistrySnapshot(stateRoot)
        const current = document.document.records[key]
        if (!current) return null
        const acquired = acquireHalfOpenLease(invalidateCapacityRecord(current, { ...identity, now: leaseTime ?? clock() }), { leaseId, owner, now: leaseTime ?? clock(), leaseMs })
        if (!acquired) return null
        document.document.records[key] = acquired.record
        await writeCapacityRegistry(stateRoot, document.document, lease)
        return acquired
      }, { now: clock })
    },
    /** Atomically claim all expired applicable scopes for one trusted Worker. */
    /** @param {RegistryProbeClaimInput} input */
    async claimHalfOpenProbe({ workerId, leaseId, owner, now: probeTime, leaseMs }) {
      const snapshot = workerSnapshot(workerId)
      identifier(leaseId, 'capacity probe leaseId')
      identifier(owner, 'capacity probe owner')
      return withCapacityRegistryLock(stateRoot, async (_paths, lease) => {
        const nowMs = probeTime ?? clock()
        const document = await readRegistrySnapshot(stateRoot)
        const decision = workerScopeDecision(document.document, workerId, nowMs)
        if (!decision.eligible || !decision.due.length) {
          if (decision.entries.some(entry => JSON.stringify(document.document.records[entry.key]) !== JSON.stringify(entry.record))) {
            for (const entry of decision.entries) document.document.records[entry.key] = entry.record
            await writeCapacityRegistry(stateRoot, document.document, lease)
          }
          return {
            eligible: decision.eligible,
            startState: decision.startState,
            capacityGeneration: decision.capacityGeneration,
            records: decision.entries,
            probe: null,
          }
        }
        const acquired = []
        for (const entry of decision.due) {
          const next = acquireHalfOpenLease(entry.record, {
            leaseId,
            owner,
            now: nowMs,
            leaseMs,
          })
          if (!next) {
            return {
              eligible: false,
              startState: 'half-open',
              capacityGeneration: decision.capacityGeneration,
              records: decision.entries,
              probe: null,
            }
          }
          acquired.push({
            key: entry.key,
            scope: entry.scope,
            leaseId: next.lease.leaseId,
            identity: entry.identity,
          })
          document.document.records[entry.key] = next.record
        }
        await writeCapacityRegistry(stateRoot, document.document, lease)
        return {
          eligible: true,
          startState: 'half-open',
          capacityGeneration: Math.max(decision.capacityGeneration, ...decision.due.map(entry => entry.record.generation + 1)),
          records: decision.entries.map(entry => ({
            ...entry,
            record: document.document.records[entry.key] ?? entry.record,
          })),
          probe: { workerId, capacityGroup: snapshot.capacityGroup, identity: snapshot.identity, leases: acquired },
        }
      }, { now: clock })
    },
    /** Complete or abandon every lease from one trusted multi-scope probe. */
    /** @param {RegistryProbeCompletionInput} input */
    async completeHalfOpenProbe({ probe, outcome, failure, now: completionTime, cooldownMs }) {
      if (!probe || !Array.isArray(probe.leases) || probe.leases.length < 1) return null
      if (!['success', 'failure', 'abandon'].includes(outcome)) throw new Error('capacity probe outcome must be success, failure, or abandon')
      const snapshot = workerSnapshot(probe.workerId)
      if (snapshot.capacityGroup !== probe.capacityGroup || JSON.stringify(snapshot.identity) !== JSON.stringify(probe.identity)) {
        throw new Error('Capacity probe owner identity does not match the trusted Worker snapshot')
      }
      const normalizedFailure = outcome === 'failure' ? parseAdapterFailure(failure) : null
      return withCapacityRegistryLock(stateRoot, async (_paths, lease) => {
        const nowMs = completionTime ?? clock()
        const document = await readRegistrySnapshot(stateRoot)
        const records = []
        let matchingFailureClaimed = false
        for (const item of probe.leases) {
          assertProbeIdentity(item, snapshot, item.scope, item.key)
          const current = document.document.records[item.key]
          if (!current) throw new Error(`Unknown capacity registry key ${item.key}`)
          if (JSON.stringify(current.capacityIdentity) !== JSON.stringify(item.identity)) {
            throw new Error('Capacity probe record identity does not match its claimed identity')
          }
          const matchingFailure = normalizedFailure && normalizedFailure.scope === current.scope
            ? normalizedFailure
            : undefined
          matchingFailureClaimed ||= matchingFailure !== undefined
          const itemOutcome = outcome === 'failure' && !matchingFailure ? 'abandon' : outcome
          const next = completeHalfOpenLease(current, {
            leaseId: item.leaseId,
            outcome: itemOutcome,
            ...(matchingFailure ? { failure: matchingFailure } : {}),
            now: nowMs,
            cooldownMs,
          })
          document.document.records[item.key] = next
          records.push({ key: item.key, scope: current.scope, record: next })
        }
        if (outcome === 'failure' && normalizedFailure && !matchingFailureClaimed) {
          const failureIdentity = scopeCapacityIdentity(normalizedFailure.scope, snapshot.identity)
          const failureKey = capacityRecordKey({
            capacityGroup: snapshot.capacityGroup,
            scope: normalizedFailure.scope,
            identity: failureIdentity,
          })
          const current = document.document.records[failureKey]
          if (current?.state === 'half-open' && current.lease) {
            throw new Error(`Capacity failure scope ${normalizedFailure.scope} is owned by another probe`)
          }
          const seed = current ?? createCapacityRecord({
            ...identity,
            capacityGroup: snapshot.capacityGroup,
            scope: normalizedFailure.scope,
            sourceWorker: snapshot.workerId,
            capacityIdentity: failureIdentity,
            now: nowMs,
          })
          const next = recordCapacityFailure(seed, normalizedFailure, {
            sourceWorker: snapshot.workerId,
            capacityIdentity: failureIdentity,
            now: nowMs,
            cooldownMs,
          })
          document.document.records[failureKey] = next
          records.push({ key: failureKey, scope: normalizedFailure.scope, record: next })
        }
        await writeCapacityRegistry(stateRoot, document.document, lease)
        return records
      }, { now: clock })
    },
    /** @param {RegistryCompletionInput} input */
    async completeHalfOpenLease({ key, leaseId, outcome, failure, now: completionTime, cooldownMs }) {
      identifier(key, 'capacity registry key')
      return withCapacityRegistryLock(stateRoot, async (_paths, lease) => {
        const document = await readRegistrySnapshot(stateRoot)
        const current = document.document.records[key]
        if (!current) throw new Error(`Unknown capacity registry key ${key}`)
        document.document.records[key] = completeHalfOpenLease(current, { leaseId, outcome, failure, now: completionTime ?? clock(), cooldownMs })
        await writeCapacityRegistry(stateRoot, document.document, lease)
        return document.document.records[key]
      }, { now: clock })
    },
    /** @param {Record<string, any>} attempt */
    async appendAttempt(attempt) {
      return withCapacityRegistryLock(stateRoot, (_paths, lease) => appendAttemptUnlocked(stateRoot, attempt, lease), { now: clock })
    },
    /** @param {Record<string, any>} attempt */
    async claimAttempt(attempt) {
      return withCapacityRegistryLock(stateRoot, (_paths, lease) => claimAttemptUnlocked(stateRoot, attempt, lease), { now: clock })
    },
    async attempts() {
      return readCapacityAttempts(stateRoot)
    },
  }
}
