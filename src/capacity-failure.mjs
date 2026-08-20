// @ts-check

/**
 * The closed failure vocabulary exchanged by an Agent Adapter and the
 * controller. Adapters report observations; a later router decides whether
 * an observation permits another Worker attempt.
 */
export const ADAPTER_FAILURE_CATEGORIES = Object.freeze([
  'capacity', 'authentication', 'billing', 'transport', 'protocol', 'host', 'task',
])

export const CAPACITY_FAILURE_REASONS = Object.freeze([
  'quota-exhausted', 'rate-limited', 'model-unavailable', 'provider-unavailable',
])

export const ADAPTER_FAILURE_REASONS = Object.freeze([
  ...CAPACITY_FAILURE_REASONS,
  'authentication-invalid', 'billing-disabled', 'transport-failure',
  'protocol-invalid', 'host-failure', 'task-failure',
])

export const ADAPTER_FAILURE_SCOPES = Object.freeze([
  'capacity-group', 'worker', 'model', 'provider', 'request',
])

export const ADAPTER_FAILURE_PHASES = Object.freeze([
  'pre-session', 'session', 'post-session',
])

export const ADAPTER_FAILURE_CONFIDENCE = Object.freeze([
  'authoritative', 'inferred', 'low',
])

const CATEGORY_SET = new Set(ADAPTER_FAILURE_CATEGORIES)
const CAPACITY_REASON_SET = new Set(CAPACITY_FAILURE_REASONS)
const REASON_SET = new Set(ADAPTER_FAILURE_REASONS)
const SCOPE_SET = new Set(ADAPTER_FAILURE_SCOPES)
const PHASE_SET = new Set(ADAPTER_FAILURE_PHASES)
const CONFIDENCE_SET = new Set(ADAPTER_FAILURE_CONFIDENCE)
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const CODE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/

/** @typedef {{category?: string, reason?: string, scope?: string, phase?: string, code?: string, confidence?: string, retryAtUtc?: string}} FailureDefaults */
/** @typedef {{phase?: string, scope?: string}} FailureOptions */

/** @param {unknown} value @param {string} name @returns {string} */
function identifier(value, name) {
  if (typeof value !== 'string' || !IDENTIFIER.test(value)) throw new Error(`${name} is invalid`)
  return value
}

/** @param {unknown} value @param {string} name @returns {string} */
function timestamp(value, name) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new Error(`${name} must be an ISO timestamp`)
  return new Date(value).toISOString()
}

/** @param {unknown} value @param {string} name @returns {string} */
function failureCode(value, name) {
  if (typeof value !== 'string' || !value.trim() || value.length > 128 || !CODE.test(value)) {
    throw new Error(`${name} must be a sanitized code`)
  }
  return value.trim().toLowerCase()
}

/** @param {unknown} value @param {string[]} allowed @param {string} name */
function exactKeys(value, allowed, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} must be an object`)
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new Error(`${name} has unknown field ${key}`)
  }
  return /** @type {Record<string, any>} */ (value)
}

/** @param {unknown} reason @returns {string} */
function categoryForReason(reason) {
  const normalizedReason = String(reason)
  if (CAPACITY_REASON_SET.has(normalizedReason)) return 'capacity'
  if (normalizedReason === 'authentication-invalid') return 'authentication'
  if (normalizedReason === 'billing-disabled') return 'billing'
  if (normalizedReason === 'transport-failure') return 'transport'
  if (normalizedReason === 'protocol-invalid') return 'protocol'
  if (normalizedReason === 'host-failure') return 'host'
  return 'task'
}

/** Validate and normalize the structured failure an Adapter reports. */
/** @param {unknown} value @param {FailureDefaults} [defaults] */
export function parseAdapterFailure(value, defaults = {}) {
  const object = exactKeys(value, [
    'version', 'category', 'reason', 'scope', 'retryAtUtc', 'phase', 'code', 'confidence',
  ], 'Adapter failure')
  if (object.version !== 1) throw new Error('Adapter failure version must be 1')
  const reason = object.reason ?? defaults.reason
  if (!REASON_SET.has(reason)) throw new Error(`Adapter failure reason ${String(reason)} is unsupported`)
  const category = object.category ?? defaults.category ?? categoryForReason(reason)
  if (!CATEGORY_SET.has(category) || categoryForReason(reason) !== category) {
    throw new Error(`Adapter failure category does not match reason ${reason}`)
  }
  const scope = object.scope ?? defaults.scope ?? (category === 'capacity' ? 'capacity-group' : 'worker')
  if (!SCOPE_SET.has(scope)) throw new Error(`Adapter failure scope ${String(scope)} is unsupported`)
  const phase = object.phase ?? defaults.phase ?? 'pre-session'
  if (!PHASE_SET.has(phase)) throw new Error(`Adapter failure phase ${String(phase)} is unsupported`)
  const confidence = object.confidence ?? defaults.confidence ?? 'authoritative'
  if (!CONFIDENCE_SET.has(confidence)) throw new Error(`Adapter failure confidence ${String(confidence)} is unsupported`)
  const code = failureCode(object.code ?? defaults.code ?? `${category}.${reason}`, 'Adapter failure code')
  const retryAtUtc = object.retryAtUtc ?? defaults.retryAtUtc
  return {
    version: 1,
    category,
    reason,
    scope,
    ...(retryAtUtc === undefined || retryAtUtc === null ? {} : { retryAtUtc: timestamp(retryAtUtc, 'Adapter failure retryAtUtc') }),
    phase,
    code,
    confidence,
  }
}

/** Return whether one parsed failure is eligible for a later routed candidate. */
/** @param {unknown} value @returns {boolean} */
export function isCapacityFailure(value) {
  try {
    return parseAdapterFailure(value).category === 'capacity'
  } catch {
    return false
  }
}

/** Return whether the failure is a capacity observation rather than task failure. */
/** @param {unknown} value @returns {boolean} */
export function canFailoverCapacityFailure(value) {
  try {
    const failure = parseAdapterFailure(value)
    return failure.category === 'capacity' && CAPACITY_REASON_SET.has(failure.reason)
  } catch {
    return false
  }
}

/** Return whether a failure should disable a capacity record until identity changes. */
/** @param {unknown} value @returns {boolean} */
export function disablesCapacity(value) {
  try {
    const failure = parseAdapterFailure(value)
    return failure.confidence === 'authoritative'
      && (failure.category === 'authentication' || failure.category === 'billing')
  } catch {
    return false
  }
}

/** A controller-readable error wrapper with a bounded structured observation. */
export class AdapterFailureError extends Error {
  /** @param {unknown} failure @param {{cause?: unknown}} [options] */
  constructor(failure, options = {}) {
    const normalized = parseAdapterFailure(failure)
    super(`Adapter ${normalized.category} failure: ${normalized.reason}`, options)
    this.name = 'AdapterFailureError'
    this.adapterFailure = normalized
  }
}

/** @param {unknown} error @param {FailureOptions} [options] @returns {Record<string, any>} */
export function adapterFailureFromError(error, options = {}) {
  const object = error && typeof error === 'object' ? /** @type {Record<string, any>} */ (error) : {}
  const structured = object.adapterFailure ?? object.failure
  if (structured !== undefined) {
    try {
      return parseAdapterFailure(structured, {
        phase: options.phase,
        scope: options.scope,
        confidence: 'authoritative',
      })
    } catch {
      return parseAdapterFailure({
        version: 1,
        category: 'protocol',
        reason: 'protocol-invalid',
        scope: options.scope ?? 'worker',
        phase: options.phase ?? 'pre-session',
        code: 'adapter.failure-invalid',
        confidence: 'authoritative',
      })
    }
  }
  const message = collectErrorText(error)
  const explicitCode = typeof object.code === 'string' ? object.code : ''
  const status = Number.isSafeInteger(object.status)
    ? object.status
    : Number.isSafeInteger(object.statusCode) ? object.statusCode : null
  const inferred = inferFailure(message, explicitCode, status)
  return parseAdapterFailure({ version: 1, ...inferred }, {
    phase: options.phase,
    scope: options.scope,
    confidence: inferred.confidence,
  })
}

/** Attach a bounded structured observation without replacing the original Error. */
/** @param {unknown} error @param {FailureOptions} [options] @returns {Error} */
export function annotateAdapterFailure(error, options = {}) {
  const failure = adapterFailureFromError(error, options)
  if (error && typeof error === 'object') {
    Object.defineProperty(error, 'adapterFailure', {
      configurable: true, enumerable: false, writable: false, value: failure,
    })
    return /** @type {Error} */ (error)
  }
  return new AdapterFailureError(failure)
}

/** @param {unknown} error @returns {string} */
function collectErrorText(error) {
  const messages = []
  const seen = new Set()
  let current = error
  while (current && typeof current === 'object' && !seen.has(current) && messages.length < 8) {
    seen.add(current)
    const object = /** @type {Record<string, any>} */ (current)
    messages.push(String(object.message || current))
    current = object.cause
  }
  return messages.join(' ')
}

/** @param {string} message @param {string} code @param {number|null} status */
function inferFailure(message, code, status) {
  const text = `${code} ${message}`
  const lowerCode = code.toLowerCase()
  if (status === 401 || status === 403 || /\b(?:unauthori[sz]ed|forbidden|invalid[_ -]?credential|authentication failed|invalid api key)\b/i.test(text)) {
    return { category: 'authentication', reason: 'authentication-invalid', scope: 'worker', code: lowerCode || 'auth.invalid', confidence: status === 401 ? 'authoritative' : 'inferred' }
  }
  if (status === 402 || /\b(?:billing|payment required|credit(?:s)? disabled|account suspended)\b/i.test(text)) {
    return { category: 'billing', reason: 'billing-disabled', scope: 'capacity-group', code: lowerCode || 'billing.disabled', confidence: status === 402 ? 'authoritative' : 'inferred' }
  }
  if (status === 429 || /\b(?:rate[ -]?limit|too many requests|throttl(?:ed|ing)|retry[- ]?after)\b/i.test(text)) {
    return { category: 'capacity', reason: 'rate-limited', scope: 'capacity-group', code: lowerCode || 'provider.rate-limit', confidence: status === 429 ? 'authoritative' : 'inferred' }
  }
  if (/\b(?:quota|usage limit|usage-limit|insufficient credits?|out of credits?|limit exceeded)\b/i.test(text)) {
    return { category: 'capacity', reason: 'quota-exhausted', scope: 'capacity-group', code: lowerCode || 'provider.usage-limit', confidence: 'inferred' }
  }
  if (/\b(?:model|deployment).{0,40}\b(?:unavailable|not found|does not exist|unsupported)\b/i.test(text)) {
    return { category: 'capacity', reason: 'model-unavailable', scope: 'model', code: lowerCode || 'model.unavailable', confidence: 'inferred' }
  }
  if (status === 502 || status === 503 || status === 504 || /\b(?:provider|upstream|service).{0,40}\b(?:unavailable|overloaded|down)\b/i.test(text)) {
    return { category: 'capacity', reason: 'provider-unavailable', scope: 'provider', code: lowerCode || 'provider.unavailable', confidence: status ? 'authoritative' : 'inferred' }
  }
  if (/\b(?:ECONNRESET|ECONNREFUSED|EAI_AGAIN|ETIMEDOUT|UND_ERR_SOCKET|network|socket|timed out|cancelled)\b/i.test(text)) {
    return { category: 'transport', reason: 'transport-failure', scope: 'request', code: lowerCode || 'transport.failure', confidence: code ? 'authoritative' : 'inferred' }
  }
  if (/\b(?:invalid (?:JSON|RPC|receipt|automation result)|malformed|unknown worker receipt|protocol)\b/i.test(text)) {
    return { category: 'protocol', reason: 'protocol-invalid', scope: 'worker', code: lowerCode || 'protocol.invalid', confidence: 'inferred' }
  }
  if (/\b(?:EBUSY|EPERM|resource busy|review workspace|host|process.{0,20}did not exit)\b/i.test(text)) {
    return { category: 'host', reason: 'host-failure', scope: 'worker', code: lowerCode || 'host.failure', confidence: 'inferred' }
  }
  return { category: 'task', reason: 'task-failure', scope: 'worker', code: lowerCode || 'task.failure', confidence: 'low' }
}
