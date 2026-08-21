// @ts-check

import { createHash } from 'node:crypto'
import {
  ADAPTER_FAILURE_CATEGORIES,
  ADAPTER_FAILURE_REASONS,
  ADAPTER_FAILURE_SCOPES,
  canFailoverCapacityFailure,
  disablesCapacity,
  parseAdapterFailure,
} from './capacity-failure.mjs'

/** Pure CapacityRecord states. Persistence and routing are layered later. */
export const CAPACITY_RECORD_STATES = Object.freeze(['available', 'cooldown', 'half-open', 'disabled'])
export const CAPACITY_RECORD_SCOPES = Object.freeze([...ADAPTER_FAILURE_SCOPES.filter(scope => scope !== 'request')])

const STATE_SET = new Set(CAPACITY_RECORD_STATES)
const SCOPE_SET = new Set(CAPACITY_RECORD_SCOPES)
const CATEGORY_SET = new Set(ADAPTER_FAILURE_CATEGORIES)
const REASON_SET = new Set(ADAPTER_FAILURE_REASONS)
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const MODEL_IDENTIFIER = /^[^\s\r\n`]{1,256}$/
const DIGEST = /^[a-f0-9]{64}$/
const DEFAULT_COOLDOWN_MS = 60_000
const MAX_COOLDOWN_MS = 24 * 60 * 60 * 1000
const MAX_INFERRED_COOLDOWN_MS = 60_000
const REASON_COOLDOWN_LIMIT_MS = Object.freeze({
  'quota-exhausted': 24 * 60 * 60 * 1000,
  'rate-limited': 60 * 60 * 1000,
  'model-unavailable': 15 * 60 * 1000,
  'provider-unavailable': 15 * 60 * 1000,
  'authentication-invalid': MAX_INFERRED_COOLDOWN_MS,
  'billing-disabled': MAX_INFERRED_COOLDOWN_MS,
})
const MAX_LEASE_MS = 15 * 60 * 1000

/** @typedef {{provider?: string|null, model?: string|null, worker?: string|null}} CapacityIdentity */

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

/** @param {unknown} value @param {string} name @returns {string|null} */
function nullableIdentifier(value, name) {
  return value === null || value === undefined ? null : identifier(value, name)
}

/** Project a legacy Worker id into a stable bounded identity. */
/** @param {unknown} value @param {string} name @returns {string} */
function workerIdentifier(value, name) {
  if (typeof value !== 'string' || !value.trim() || value.length > 256 || /[\r\n`]/.test(value)) {
    throw new Error(`${name} must be a non-empty Worker id`)
  }
  return IDENTIFIER.test(value) ? value : `worker-${createHash('sha256').update(value).digest('hex')}`
}

/** @param {unknown} value @param {string} name @returns {{provider: string, model: string}} */
function providerModelTuple(value, name) {
  if (typeof value !== 'string' || !value.trim() || /[\r\n`]/.test(value)) throw new Error(`${name} must be provider/model`)
  const separator = value.indexOf('/')
  if (separator < 1 || separator === value.length - 1) throw new Error(`${name} must be provider/model`)
  const provider = value.slice(0, separator)
  const model = value.slice(separator + 1)
  return {
    provider: identifier(provider, `${name} provider`),
    model: modelIdentifier(model, `${name} model`),
  }
}

/** @param {unknown} value @param {string} name @returns {string} */
function modelIdentifier(value, name) {
  if (typeof value !== 'string' || !MODEL_IDENTIFIER.test(value)) throw new Error(`${name} must be a bounded model identifier`)
  return value
}

/** @param {unknown} value @param {string} scope @returns {CapacityIdentity} */
function parseCapacityIdentity(value, scope) {
  const object = exactKeys(value ?? {}, ['provider', 'model', 'worker'], 'CapacityRecord capacityIdentity')
  const identity = {
    provider: nullableIdentifier(object.provider, 'CapacityRecord capacityIdentity provider'),
    model: object.model === null || object.model === undefined
      ? null : modelIdentifier(object.model, 'CapacityRecord capacityIdentity model'),
    worker: object.worker === null || object.worker === undefined
      ? null : workerIdentifier(object.worker, 'CapacityRecord capacityIdentity worker'),
  }
  if (scope === 'provider' && identity.provider === null) throw new Error('CapacityRecord provider scope requires provider identity')
  if (scope === 'model' && (identity.provider === null || identity.model === null)) {
    throw new Error('CapacityRecord model scope requires provider and model identity')
  }
  if (scope === 'worker' && identity.worker === null) throw new Error('CapacityRecord worker scope requires Worker identity')
  return identity
}

/** @param {CapacityIdentity} left @param {CapacityIdentity} right @returns {boolean} */
function sameCapacityIdentity(left, right) {
  return left.provider === right.provider && left.model === right.model && left.worker === right.worker
}

/** @param {string} scope @param {CapacityIdentity} left @param {CapacityIdentity} right @returns {boolean} */
function sameCapacityScopeIdentity(scope, left, right) {
  if (scope === 'worker') return sameCapacityIdentity(left, right)
  if (scope === 'model') return left.provider === right.provider && left.model === right.model
  if (scope === 'provider') return left.provider === right.provider
  return true
}

/** Project only trusted Worker configuration fields into a capacity identity. */
/** @param {string} workerId @param {Record<string, any>} worker @returns {CapacityIdentity} */
export function projectWorkerCapacityIdentity(workerId, worker) {
  if (!worker || typeof worker !== 'object' || Array.isArray(worker)) {
    throw new Error(`workers.${workerId} must be an object`)
  }
  const normalizedWorker = /** @type {Record<string, any>} */ (worker)
  const configuredProvider = normalizedWorker.provider === undefined
    ? null : identifier(normalizedWorker.provider, `workers.${workerId}.provider`)
  const configuredModel = normalizedWorker.model === undefined ? null : normalizedWorker.model
  const tuple = normalizedWorker.adapter === 'opencode-cli'
    ? providerModelTuple(configuredModel, `workers.${workerId}.model`)
    : null
  if (tuple && configuredProvider !== null && configuredProvider !== tuple.provider) {
    throw new Error(`workers.${workerId} provider does not match its model tuple`)
  }
  return {
    provider: tuple?.provider ?? configuredProvider,
    model: tuple?.model ?? (configuredModel === null ? null : modelIdentifier(configuredModel, `workers.${workerId}.model`)),
    worker: workerIdentifier(workerId, 'capacity Worker'),
  }
}

/** @param {unknown} value @param {string[]} allowed @param {string} name @returns {Record<string, any>} */
function exactKeys(value, allowed, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} must be an object`)
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new Error(`${name} has unknown field ${key}`)
  }
  return /** @type {Record<string, any>} */ (value)
}

/** @param {unknown} value @param {string} name @returns {string|null} */
function nullableCode(value, name) {
  if (value === null || value === undefined) return null
  if (typeof value !== 'string' || !IDENTIFIER.test(value)) throw new Error(`${name} must be a sanitized code`)
  return value.toLowerCase()
}

/** @param {unknown} value @param {string} name @returns {string} */
function failureReason(value, name) {
  if (typeof value !== 'string' || !REASON_SET.has(value)) throw new Error(`${name} is unsupported`)
  return value
}

/** @param {unknown} value @param {string} name @returns {string} */
function failureCategory(value, name) {
  if (typeof value !== 'string' || !CATEGORY_SET.has(value)) throw new Error(`${name} is unsupported`)
  return value
}

/** @param {unknown} value @param {string} name @returns {number} */
function nonNegativeInteger(value, name) {
  if (!Number.isSafeInteger(value) || /** @type {number} */ (value) < 0) throw new Error(`${name} must be a non-negative integer`)
  return /** @type {number} */ (value)
}

/** @param {unknown} value @param {string} name @returns {number} */
function positiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || /** @type {number} */ (value) < 1) throw new Error(`${name} must be a positive integer`)
  return /** @type {number} */ (value)
}

/** @param {unknown} value @returns {{leaseId: string, owner: string, acquiredAt: string, expiresAt: string}|null} */
function parseLease(value) {
  if (value === null || value === undefined) return null
  const object = exactKeys(value, ['leaseId', 'owner', 'acquiredAt', 'expiresAt'], 'CapacityRecord lease')
  const acquiredAt = timestamp(object.acquiredAt, 'CapacityRecord lease acquiredAt')
  const expiresAt = timestamp(object.expiresAt, 'CapacityRecord lease expiresAt')
  if (Date.parse(expiresAt) <= Date.parse(acquiredAt)) throw new Error('CapacityRecord lease must expire after acquisition')
  return {
    leaseId: identifier(object.leaseId, 'CapacityRecord lease leaseId'),
    owner: identifier(object.owner, 'CapacityRecord lease owner'),
    acquiredAt,
    expiresAt,
  }
}

/** @param {string} reason @returns {string} */
function categoryForReason(reason) {
  if (['quota-exhausted', 'rate-limited', 'model-unavailable', 'provider-unavailable'].includes(reason)) return 'capacity'
  if (reason === 'authentication-invalid') return 'authentication'
  if (reason === 'billing-disabled') return 'billing'
  if (reason === 'protocol-invalid') return 'protocol'
  if (reason === 'transport-failure') return 'transport'
  if (reason === 'host-failure') return 'host'
  return 'task'
}

/** Strictly validate and normalize one machine-local CapacityRecord v1. */
/** @param {unknown} value @returns {Record<string, any>} */
export function parseCapacityRecord(value) {
  const object = exactKeys(value, [
    'version', 'capacityGroup', 'scope', 'state', 'reason', 'code', 'observedAt',
    'retryAtUtc', 'sourceWorker', 'capacityIdentity', 'configurationHash', 'credentialGeneration', 'generation', 'lease',
  ], 'CapacityRecord')
  if (object.version !== 1) throw new Error('CapacityRecord version must be 1')
  const scope = object.scope
  if (!SCOPE_SET.has(scope)) throw new Error(`CapacityRecord scope ${String(scope)} is unsupported`)
  const state = object.state
  if (!STATE_SET.has(state)) throw new Error(`CapacityRecord state ${String(state)} is unsupported`)
  const reason = object.reason === null || object.reason === undefined ? null : failureReason(object.reason, 'CapacityRecord reason')
  const code = nullableCode(object.code, 'CapacityRecord code')
  const retryAtUtc = object.retryAtUtc === null || object.retryAtUtc === undefined ? null : timestamp(object.retryAtUtc, 'CapacityRecord retryAtUtc')
  const sourceWorker = object.sourceWorker === null || object.sourceWorker === undefined
    ? null : workerIdentifier(object.sourceWorker, 'CapacityRecord sourceWorker')
  const capacityIdentity = parseCapacityIdentity(object.capacityIdentity, scope)
  const lease = parseLease(object.lease)
  if (state === 'cooldown' && retryAtUtc === null) throw new Error('CapacityRecord cooldown requires retryAtUtc')
  if (state === 'half-open' && lease === null) throw new Error('CapacityRecord half-open requires an exclusive lease')
  if (state !== 'half-open' && lease !== null) throw new Error('CapacityRecord lease is only valid in half-open state')
  if (state === 'available' && (reason !== null || code !== null || retryAtUtc !== null)) {
    throw new Error('CapacityRecord available state cannot retain failure details')
  }
  if ((state === 'cooldown' || state === 'half-open')
    && (reason === null || !['capacity', 'authentication', 'billing'].includes(categoryForReason(reason)))) {
    throw new Error(`CapacityRecord ${state} state requires a capacity or temporary identity reason`)
  }
  if (state === 'disabled' && (reason === null || !['authentication-invalid', 'billing-disabled'].includes(reason))) {
    throw new Error('CapacityRecord disabled state requires an identity or billing reason')
  }
  if (state === 'disabled' && retryAtUtc !== null) throw new Error('CapacityRecord disabled state cannot have retryAtUtc')
  if ((scope === 'worker' || scope === 'model') && sourceWorker === null) {
    throw new Error(`CapacityRecord ${scope} scope requires a source Worker`)
  }
  return {
    version: 1,
    capacityGroup: identifier(object.capacityGroup, 'CapacityRecord capacityGroup'),
    scope,
    state,
    reason,
    code,
    observedAt: timestamp(object.observedAt, 'CapacityRecord observedAt'),
    retryAtUtc,
    sourceWorker,
    capacityIdentity,
    configurationHash: digest(object.configurationHash, 'CapacityRecord configurationHash'),
    credentialGeneration: identifier(object.credentialGeneration, 'CapacityRecord credentialGeneration'),
    generation: nonNegativeInteger(object.generation, 'CapacityRecord generation'),
    lease,
  }
}

/** Create an available CapacityRecord v1 for one machine-local identity. */
/** @param {{capacityGroup: string, scope?: string, sourceWorker?: string, capacityIdentity?: CapacityIdentity, configurationHash: string, credentialGeneration: string, now?: number}} input */
export function createCapacityRecord(input) {
  const now = new Date(input.now ?? Date.now()).toISOString()
  const scope = input.scope ?? 'capacity-group'
  const capacityIdentity = input.capacityIdentity ?? { worker: input.sourceWorker ?? null }
  return parseCapacityRecord({
    version: 1,
    capacityGroup: input.capacityGroup,
    scope,
    state: 'available',
    reason: null,
    code: null,
    observedAt: now,
    retryAtUtc: null,
    sourceWorker: input.sourceWorker === undefined ? null : workerIdentifier(input.sourceWorker, 'capacity source Worker'),
    capacityIdentity,
    configurationHash: input.configurationHash,
    credentialGeneration: input.credentialGeneration,
    generation: 0,
    lease: null,
  })
}

/** Move a record to cooldown or disabled after one structured Adapter observation. */
/** @param {Record<string, any>} record @param {unknown} failure @param {{sourceWorker?: string, capacityIdentity?: CapacityIdentity, now?: number, cooldownMs?: number}} [options] */
export function recordCapacityFailure(record, failure, options = {}) {
  const current = parseCapacityRecord(record)
  const normalized = parseAdapterFailure(failure)
  const identityFailure = normalized.category === 'authentication' || normalized.category === 'billing'
  if (!canFailoverCapacityFailure(normalized) && !identityFailure) {
    throw new Error(`Capacity registry cannot record ${normalized.category}/${normalized.reason}`)
  }
  if (current.scope !== normalized.scope) throw new Error(`CapacityRecord scope ${current.scope} does not match structured failure scope ${normalized.scope}`)
  const nowMs = options.now ?? Date.now()
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new Error('capacity observation time is invalid')
  const sourceWorker = workerIdentifier(options.sourceWorker ?? current.sourceWorker, 'capacity source Worker')
  const capacityIdentity = parseCapacityIdentity(options.capacityIdentity ?? current.capacityIdentity, current.scope)
  if (!sameCapacityScopeIdentity(current.scope, capacityIdentity, current.capacityIdentity)) throw new Error('CapacityRecord identity does not match structured failure source')
  const cooldownMs = options.cooldownMs ?? DEFAULT_COOLDOWN_MS
  if (!Number.isSafeInteger(cooldownMs) || cooldownMs < 1 || cooldownMs > MAX_COOLDOWN_MS) throw new Error('capacity cooldownMs is out of bounds')
  const disabled = disablesCapacity(normalized)
  const reasonLimit = /** @type {Record<string, number>} */ (REASON_COOLDOWN_LIMIT_MS)[normalized.reason] ?? MAX_INFERRED_COOLDOWN_MS
  const confidenceLimit = normalized.confidence === 'authoritative' ? reasonLimit : MAX_INFERRED_COOLDOWN_MS
  const cooldownLimit = Math.min(reasonLimit, confidenceLimit, MAX_COOLDOWN_MS)
  const requestedRetryMs = normalized.retryAtUtc ? Math.max(Date.parse(normalized.retryAtUtc), nowMs) : nowMs + cooldownMs
  const retryAtUtc = disabled ? null : new Date(Math.min(requestedRetryMs, nowMs + cooldownLimit)).toISOString()
  return parseCapacityRecord({
    ...current,
    state: disabled ? 'disabled' : 'cooldown',
    reason: normalized.reason,
    code: normalized.code,
    observedAt: new Date(nowMs).toISOString(),
    retryAtUtc,
    sourceWorker,
    capacityIdentity,
    generation: current.generation + 1,
    lease: null,
  })
}

/** Alias named after the durable event recorded by a future role router. */
export const applyCapacityFailure = recordCapacityFailure

/** Reopen a disabled record only when configuration or credential generation changed. */
/** @param {Record<string, any>} record @param {{configurationHash: string, credentialGeneration: string, now?: number}} input */
export function invalidateCapacityRecord(record, input) {
  const current = parseCapacityRecord(record)
  const configurationHash = digest(input.configurationHash, 'configurationHash')
  const credentialGeneration = identifier(input.credentialGeneration, 'credentialGeneration')
  if (current.state !== 'disabled' || (current.configurationHash === configurationHash && current.credentialGeneration === credentialGeneration)) return current
  const nowMs = input.now ?? Date.now()
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new Error('capacity invalidation time is invalid')
  return parseCapacityRecord({
    ...current,
    state: 'available',
    reason: null,
    code: null,
    observedAt: new Date(nowMs).toISOString(),
    retryAtUtc: null,
    configurationHash,
    credentialGeneration,
    generation: current.generation + 1,
    lease: null,
  })
}

/** Acquire the sole bounded half-open probe for a recovering record. */
/** @param {Record<string, any>} record @param {{leaseId: string, owner: string, now?: number, leaseMs?: number}} input @returns {{record: Record<string, any>, lease: Record<string, string>}|null} */
export function acquireHalfOpenLease(record, input) {
  const current = parseCapacityRecord(record)
  const nowMs = input.now ?? Date.now()
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new Error('capacity lease time is invalid')
  const leaseMs = input.leaseMs ?? 60_000
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 1 || leaseMs > MAX_LEASE_MS) throw new Error('capacity leaseMs is out of bounds')
  const leaseId = identifier(input.leaseId, 'capacity leaseId')
  const owner = identifier(input.owner, 'capacity lease owner')
  if (current.state === 'disabled' || current.state === 'available') return null
  if (current.state === 'cooldown' && (!current.retryAtUtc || Date.parse(current.retryAtUtc) > nowMs)) return null
  if (current.state === 'half-open' && current.lease && Date.parse(current.lease.expiresAt) > nowMs) return null
  const lease = {
    leaseId,
    owner,
    acquiredAt: new Date(nowMs).toISOString(),
    expiresAt: new Date(nowMs + leaseMs).toISOString(),
  }
  const next = parseCapacityRecord({
    ...current,
    state: 'half-open',
    observedAt: new Date(nowMs).toISOString(),
    retryAtUtc: null,
    generation: current.generation + 1,
    lease,
  })
  return { record: next, lease }
}

export const acquireCapacityProbeLease = acquireHalfOpenLease

/** Complete or fail an exclusive half-open probe. */
/** @param {Record<string, any>} record @param {{leaseId: string, outcome: string, failure?: unknown, now?: number, cooldownMs?: number, sourceWorker?: string, capacityIdentity?: CapacityIdentity}} input */
export function completeHalfOpenLease(record, input) {
  const current = parseCapacityRecord(record)
  if (current.state !== 'half-open' || !current.lease || current.lease.leaseId !== input.leaseId) throw new Error('capacity half-open lease owner does not match')
  const nowMs = input.now ?? Date.now()
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new Error('capacity completion time is invalid')
  if (Date.parse(current.lease.expiresAt) <= nowMs) throw new Error('capacity half-open lease has expired')
  if (input.outcome === 'abandon') {
    if (!current.reason) throw new Error('capacity probe abandonment requires the prior failure reason')
    return parseCapacityRecord({
      ...current,
      state: 'cooldown',
      retryAtUtc: new Date(nowMs + DEFAULT_COOLDOWN_MS).toISOString(),
      observedAt: new Date(nowMs).toISOString(),
      generation: current.generation + 1,
      lease: null,
    })
  }
  if (input.outcome === 'success') {
    return parseCapacityRecord({
      ...current,
      state: 'available', reason: null, code: null, observedAt: new Date(nowMs).toISOString(), retryAtUtc: null,
      generation: current.generation + 1, lease: null,
    })
  }
  if (input.outcome !== 'failure' || input.failure === undefined) throw new Error('capacity probe outcome must be success or failure')
  return recordCapacityFailure(current, input.failure, { ...input, now: nowMs })
}

export const releaseHalfOpenLease = completeHalfOpenLease

/** Return a pure availability decision without mutating the durable record. */
/** @param {Record<string, any>} record @param {{now?: number, configurationHash?: string, credentialGeneration?: string}} [input] */
export function capacityEligibility(record, input = {}) {
  const current = parseCapacityRecord(record)
  if (input.configurationHash && input.credentialGeneration) {
    const refreshed = invalidateCapacityRecord(current, {
      configurationHash: input.configurationHash,
      credentialGeneration: input.credentialGeneration,
      now: input.now,
    })
    if (refreshed.state === 'available') return { eligible: true, state: refreshed.state, record: refreshed }
  }
  const nowMs = input.now ?? Date.now()
  if (current.state === 'available') return { eligible: true, state: 'available', record: current }
  if (current.state === 'cooldown' && current.retryAtUtc && Date.parse(current.retryAtUtc) <= nowMs) {
    return { eligible: true, state: 'half-open', requiresProbe: true, record: current }
  }
  return { eligible: false, state: current.state, record: current }
}
