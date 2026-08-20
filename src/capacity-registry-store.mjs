// @ts-check

import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, readdir, rm, rename } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import {
  ADAPTER_FAILURE_CATEGORIES,
  ADAPTER_FAILURE_REASONS,
  parseAdapterFailure,
} from './capacity-failure.mjs'
import {
  CAPACITY_RECORD_SCOPES,
  CAPACITY_RECORD_STATES,
  acquireHalfOpenLease,
  createCapacityRecord,
  invalidateCapacityRecord,
  parseCapacityRecord,
  projectWorkerCapacityIdentity,
  recordCapacityFailure,
  completeHalfOpenLease,
} from './capacity-registry.mjs'

export const CAPACITY_ATTEMPT_RESULTS = Object.freeze([
  'completed', 'blocked', 'capacity-failure', 'capacity-deferred', 'failed', 'timed-out',
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
const ATTEMPT_COMPACTION_THRESHOLD = 64
const READ_RETRIES = 8

/** @typedef {{provider?: string|null, model?: string|null, worker?: string|null}} CapacityIdentity */
/** @typedef {{stateRoot: string, configurationHash: string, credentialGeneration: string, workers?: Record<string, any>, now?: number}} RegistryOptions */
/** @typedef {{key?: string, capacityGroup: string, scope?: string, sourceWorker: string, failure: unknown, now?: number, cooldownMs?: number}} RegistryFailureInput */
/** @typedef {{key: string, leaseId: string, owner: string, now?: number, leaseMs?: number}} RegistryLeaseInput */
/** @typedef {{key: string, leaseId: string, outcome: string, failure?: unknown, now?: number, cooldownMs?: number, sourceWorker?: string}} RegistryCompletionInput */

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
    'capacityGroup', 'capacityGeneration', 'startState', 'startedAt', 'endedAt', 'result',
  ], 'Capacity attempt')
  if (object.version !== 1) throw new Error('Capacity attempt version must be 1')
  const startState = object.startState
  if (!STATE_SET.has(startState)) throw new Error('Capacity attempt startState is unsupported')
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
    if (!['ENOENT', 'EPERM', 'EBUSY'].includes(String(errorCode(error)))) throw error
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

/** @param {string} stateRoot @param {Record<string, any>} attempt @param {{waitMs?: number, leaseMs?: number}} [options] */
export async function appendCapacityAttempt(stateRoot, attempt, options = {}) {
  const normalized = parseCapacityAttempt(attempt)
  return withCapacityRegistryLock(stateRoot, (_paths, lease) => appendAttemptUnlocked(stateRoot, normalized, lease), options)
}

/** @param {unknown} value @returns {{version: 1, ownerToken: string, fence: number, acquiredAt: string, expiresAt: string}} */
function parseLease(value) {
  const object = exactKeys(value, ['version', 'ownerToken', 'fence', 'acquiredAt', 'expiresAt'], 'Capacity registry lease')
  if (object.version !== 1) throw new Error('Capacity registry lease version must be 1')
  const acquiredAt = timestamp(object.acquiredAt, 'Capacity registry lease acquiredAt')
  const expiresAt = timestamp(object.expiresAt, 'Capacity registry lease expiresAt')
  if (Date.parse(expiresAt) <= Date.parse(acquiredAt)) throw new Error('Capacity registry lease expiresAt must follow acquiredAt')
  if (!Number.isSafeInteger(object.fence) || object.fence < 0) throw new Error('Capacity registry lease fence must be a non-negative integer')
  return { version: 1, ownerToken: identifier(object.ownerToken, 'Capacity registry lease ownerToken'), fence: object.fence, acquiredAt, expiresAt }
}

/** @param {string} directory @param {string} prefix @returns {Promise<Array<{name: string, lease: ReturnType<typeof parseLease>}>>} */
async function readLeases(directory, prefix) {
  let names
  try {
    names = (await readdir(directory)).filter(name => name.startsWith(`${prefix}.`) && name.endsWith('.json')).sort()
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return []
    throw error
  }
  const leases = []
  for (const name of names) {
    let value
    for (let attempt = 0; attempt < READ_RETRIES; attempt += 1) {
      try {
        value = JSON.parse(await readFile(join(directory, name), 'utf8'))
        break
      } catch (error) {
        if (errorCode(error) === 'ENOENT') break
        if (!['EPERM', 'EBUSY'].includes(String(errorCode(error))) || attempt === READ_RETRIES - 1) throw error
        await new Promise(resolvePromise => setTimeout(resolvePromise, 2))
      }
    }
    if (value === null) continue
    if (value === undefined) continue
    leases.push({ name, lease: parseLease(value) })
  }
  return leases
}

/** @param {Array<{name: string, lease: ReturnType<typeof parseLease>}>} leases @returns {{name: string, lease: ReturnType<typeof parseLease>}|null} */
function activeLease(leases) {
  const now = Date.now()
  return leases.filter(item => Date.parse(item.lease.expiresAt) > now)
    .sort((left, right) => left.lease.fence - right.lease.fence || left.lease.ownerToken.localeCompare(right.lease.ownerToken)).at(-1) ?? null
}

/** @param {string} directory @param {string} snapshotPrefix @param {string} leasePrefix @returns {Promise<number>} */
async function highestFence(directory, snapshotPrefix, leasePrefix) {
  const files = await snapshotFiles(directory, snapshotPrefix)
  let highest = 0
  for (const name of files) {
    const value = await readJsonRaceSafe(join(directory, name))
    if (value === null) continue
    highest = Math.max(highest, parseFencedSnapshot(value, `${snapshotPrefix} snapshot`).fence)
  }
  for (const item of await readLeases(directory, leasePrefix)) highest = Math.max(highest, item.lease.fence)
  return highest
}

/** @param {string} directory @param {string} path @param {ReturnType<typeof parseLease>} lease */
async function createLease(directory, path, lease) {
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

/** @param {ReturnType<typeof capacityRegistryPaths>} paths @param {string} ownerToken @param {number} fence */
async function assertLeaseOwner(paths, ownerToken, fence) {
  const leases = await readLeases(paths.directory, paths.leasePrefix)
  const current = activeLease(leases)
  if (!current || current.lease.ownerToken !== ownerToken || current.lease.fence !== fence) throw new Error('Capacity registry lease ownership was lost')
}

/** Execute one mutation under owner-addressed, fenced leases. */
/** @param {string} stateRoot @param {(paths: ReturnType<typeof capacityRegistryPaths>, lease: {ownerToken: string, fence: number, assertOwner: () => Promise<void>}) => Promise<any>} operation @param {{waitMs?: number, leaseMs?: number}} [options] */
export async function withCapacityRegistryLock(stateRoot, operation, options = {}) {
  const paths = capacityRegistryPaths(stateRoot)
  await mkdir(paths.directory, { recursive: true })
  const waitMs = options.waitMs ?? DEFAULT_LOCK_WAIT_MS
  const leaseMs = options.leaseMs ?? DEFAULT_LOCK_LEASE_MS
  if (!Number.isSafeInteger(waitMs) || waitMs < 0 || waitMs > MAX_LOCK_WAIT_MS) throw new Error('capacity lock waitMs is out of bounds')
  if (!Number.isSafeInteger(leaseMs) || leaseMs < MIN_LOCK_LEASE_MS || leaseMs > MAX_LOCK_LEASE_MS) throw new Error('capacity lock leaseMs is out of bounds')
  const deadline = Date.now() + waitMs
  const ownerToken = randomUUID()
  const ownerPath = join(paths.directory, `${paths.leasePrefix}.${ownerToken}.json`)
  while (true) {
    let acquired = null
    while (!acquired) {
      const existing = activeLease(await readLeases(paths.directory, paths.leasePrefix))
      if (existing) {
        if (Date.now() >= deadline) throw new Error('Capacity registry lock is busy')
        await new Promise(resolvePromise => setTimeout(resolvePromise, 10))
        continue
      }
      const fence = Math.max(
        Date.now(),
        await highestFence(paths.directory, paths.recordPrefix, paths.leasePrefix),
        await highestFence(paths.directory, paths.attemptsEventPrefix, paths.leasePrefix),
        await highestFence(paths.directory, paths.attemptsBasePrefix, paths.leasePrefix),
      ) + 1
      const nowMs = Date.now()
      const lease = parseLease({ version: 1, ownerToken, fence, acquiredAt: new Date(nowMs).toISOString(), expiresAt: new Date(nowMs + leaseMs).toISOString() })
      try {
        await createLease(paths.directory, ownerPath, lease)
      } catch (error) {
        if (errorCode(error) !== 'EEXIST') throw error
      }
      const current = activeLease(await readLeases(paths.directory, paths.leasePrefix))
      if (current?.lease.ownerToken === ownerToken && current.lease.fence === fence) {
        acquired = lease
        break
      }
      await bestEffortRemove(ownerPath)
      if (Date.now() >= deadline) throw new Error('Capacity registry lock is busy')
      await new Promise(resolvePromise => setTimeout(resolvePromise, 10))
    }
    const assertOwner = () => assertLeaseOwner(paths, ownerToken, acquired.fence)
    try {
      const result = await operation(paths, { ownerToken, fence: acquired.fence, assertOwner })
      await assertOwner()
      return result
    } catch (error) {
      if (!(error instanceof Error && error.message === 'Capacity registry lease ownership was lost' && Date.now() < deadline)) throw error
    } finally {
      await bestEffortRemove(ownerPath)
    }
  }
}

/** Build a state-root-bound registry facade from trusted Worker snapshots. */
/** @param {RegistryOptions} input */
export function createCapacityRegistry({ stateRoot, configurationHash, credentialGeneration, workers = {}, now = Date.now() }) {
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
  const identity = { configurationHash, credentialGeneration }
  const clock = () => now
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
      })
    },
    /** @param {string} key */
    async get(key) {
      identifier(key, 'capacity registry key')
      return (await this.records())[key] ?? null
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
      })
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
      })
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
      })
    },
    /** @param {Record<string, any>} attempt */
    async appendAttempt(attempt) {
      return withCapacityRegistryLock(stateRoot, (_paths, lease) => appendAttemptUnlocked(stateRoot, attempt, lease))
    },
    async attempts() {
      return readCapacityAttempts(stateRoot)
    },
  }
}
