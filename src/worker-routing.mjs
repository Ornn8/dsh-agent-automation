// @ts-check

import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { withCapacityRegistryLock } from './capacity-registry-store.mjs'

/**
 * Worker-neutral task classification and durable route-decision validation.
 * Concrete Worker resolution remains in machine configuration and later runtime stages.
 */

const SHA256 = /^[0-9a-f]{64}$/
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const MAX_ROUTE_CLASSES = 32
const MAX_RULES = 16
const MAX_RULE_DEPTH = 4
const MAX_RULE_VALUES = 32
const MAX_LABELS = 100
const MAX_PATHS = 100
const MAX_TEXT = 4096
const ROUTE_DECISION_MARKER = '<!-- worker-route-decision:v1 -->'
const ROUTE_DECISION_TRAILER = '<!-- /worker-route-decision:v1 -->'
const DECISION_FIELDS = new Set([
  'version', 'workRequestId', 'role', 'stateVersion', 'taskClass', 'policyHash', 'evidenceHash',
])
const ROUTING_EXECUTION_FIELDS = new Set(['version', 'routingAttemptId', 'routeDecision'])
const ROUTING_ATTEMPT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/
const CLASSIFICATION_SOURCES = new Set([
  'trusted-route', 'deterministic-rules', 'optional-classifier', 'default',
])
const CLASSIFICATION_FIELDS = new Set([
  'version', 'workRequestId', 'role', 'stateVersion', 'taskClass', 'policyHash', 'evidenceHash', 'source',
])
const WORKER_ROUTE_ROLES = new Set(['change', 'review'])
const ROUTING_RECORD_VERSION = 1

/** @typedef {any} AnyValue Recursive JSON values are bounded and normalized before hashing. */
/** @typedef {Record<string, any>} AnyObject */

/** @param {AnyValue} value @returns {string} */
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

/** Reject duplicate member names before JSON.parse can collapse them.
 * @param {string} text
 * @returns {void}
 */
function rejectDuplicateJsonMembers(text) {
  let index = 0

  function skipWhitespace() {
    while (index < text.length && /[\u0009\u000a\u000d\u0020]/.test(text[index])) index += 1
  }

  /** @returns {string|undefined} */
  function scanString() {
    const start = index
    index += 1
    while (index < text.length) {
      const character = text[index]
      index += 1
      if (character === '\\') {
        if (index < text.length) index += 1
        continue
      }
      if (character === '"') {
        try {
          return JSON.parse(text.slice(start, index))
        } catch {
          return undefined
        }
      }
    }
    return undefined
  }

  function scanValue() {
    skipWhitespace()
    if (text[index] === '{') {
      scanObject()
      return
    }
    if (text[index] === '[') {
      scanArray()
      return
    }
    if (text[index] === '"') {
      scanString()
      return
    }
    while (index < text.length && !/[,\]}\u0009\u000a\u000d\u0020]/.test(text[index])) index += 1
  }

  function scanObject() {
    index += 1
    const members = new Set()
    skipWhitespace()
    if (text[index] === '}') {
      index += 1
      return
    }
    while (index < text.length) {
      skipWhitespace()
      if (text[index] !== '"') return
      const member = scanString()
      if (member === undefined) return
      if (members.has(member)) throw new Error(`WorkerRouteDecision body has duplicate JSON member ${member}`)
      members.add(member)
      skipWhitespace()
      if (text[index] !== ':') return
      index += 1
      scanValue()
      skipWhitespace()
      if (text[index] === '}') {
        index += 1
        return
      }
      if (text[index] !== ',') return
      index += 1
    }
  }

  function scanArray() {
    index += 1
    skipWhitespace()
    if (text[index] === ']') {
      index += 1
      return
    }
    while (index < text.length) {
      scanValue()
      skipWhitespace()
      if (text[index] === ']') {
        index += 1
        return
      }
      if (text[index] !== ',') return
      index += 1
    }
  }

  scanValue()
}

/** @param {AnyValue} value @returns {string} */
function digest(value) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex')
}

/** @param {string} left @param {string} right @returns {number} */
function compareOrdinal(left, right) {
  return left < right ? -1 : left > right ? 1 : 0
}

/** @param {AnyValue} value @param {string} name @param {number} maximum @returns {string} */
function boundedText(value, name, maximum = MAX_TEXT) {
  if (typeof value !== 'string' || value.length > maximum || /[\r\n]/.test(value)) {
    throw new Error(`${name} must be one-line text of at most ${maximum} characters`)
  }
  return value.trim()
}

/** @param {AnyValue} value @param {string} name @returns {string} */
function identifier(value, name) {
  if (typeof value !== 'string' || !ID.test(value)) throw new Error(`${name} must be an identifier`)
  return value
}

/** @param {AnyValue} value @param {string} name @param {number} maximum @param {number} itemMaximum @returns {string[]} */
function textList(value, name, maximum = MAX_RULE_VALUES, itemMaximum = 128) {
  if (!Array.isArray(value) || value.length > maximum) throw new Error(`${name} must contain at most ${maximum} values`)
  const result = value.map((item, index) => boundedText(item, `${name}[${index}]`, itemMaximum))
  if (result.some(item => !item) || new Set(result).size !== result.length) throw new Error(`${name} must contain unique non-empty values`)
  return result
}

/** @param {AnyValue} value @param {string} name @param {number} maximum @returns {string|undefined} */
function optionalText(value, name, maximum = MAX_TEXT) {
  if (value === undefined || value === null) return undefined
  const result = boundedText(value, name, maximum)
  return result || undefined
}

/** @param {AnyValue} value @param {string} name @param {number} maximum @returns {string|undefined} */
function safeOptionalText(value, name, maximum = MAX_TEXT) {
  try {
    return optionalText(value, name, maximum)
  } catch {
    return undefined
  }
}

/** @param {AnyValue} value @param {number} maximum @returns {string} */
function boundedEvidenceText(value, maximum = MAX_TEXT) {
  return typeof value === 'string' ? value.slice(0, maximum).trim() : ''
}

/** @param {AnyValue} value @param {string} name @param {number} depth @returns {AnyObject} */
function normalizePolicyRule(value, name, depth = 0) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} must be an object`)
  if (depth > MAX_RULE_DEPTH) throw new Error(`${name} exceeds the maximum rule depth`)
  const allowed = new Set([
    'labelsAny', 'labelsAll', 'pathPrefixes', 'pathContains', 'extensions',
    'workflowStages', 'failureClasses', 'titleIncludes', 'bodyIncludes', 'any', 'all',
  ])
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`${name} has unknown field ${key}`)
  const result = /** @type {AnyObject} */ ({})
  for (const key of ['labelsAny', 'labelsAll', 'pathPrefixes', 'pathContains', 'extensions', 'workflowStages', 'failureClasses', 'titleIncludes', 'bodyIncludes']) {
    if (value[key] !== undefined) result[key] = textList(value[key], `${name}.${key}`)
  }
  for (const key of ['any', 'all']) {
    if (value[key] !== undefined) {
      if (!Array.isArray(value[key]) || value[key].length > MAX_RULES) throw new Error(`${name}.${key} must contain at most ${MAX_RULES} rules`)
      result[key] = value[key].map((item, index) => normalizePolicyRule(item, `${name}.${key}[${index}]`, depth + 1))
    }
  }
  return result
}

/** @param {AnyValue} policy @returns {AnyObject} */
function normalizeRoutingPolicy(policy) {
  const source = policy === undefined || policy === null ? {} : policy
  if (!source || typeof source !== 'object' || Array.isArray(source)) throw new Error('routingPolicy must be an object')
  const allowed = new Set([
    'version', 'default', 'defaultRoute', 'routes', 'classes', 'classificationOrder',
    'maxCandidates', 'classifier', 'classifierMinimumConfidence',
  ])
  for (const key of Object.keys(source)) if (!allowed.has(key)) throw new Error(`routingPolicy has unknown field ${key}`)
  if (source.version !== undefined && source.version !== 1) throw new Error('routingPolicy version must be 1')
  if (source.classifierMinimumConfidence !== undefined
    && (typeof source.classifierMinimumConfidence !== 'number'
      || !Number.isFinite(source.classifierMinimumConfidence)
      || source.classifierMinimumConfidence < 0
      || source.classifierMinimumConfidence > 1)) {
    throw new Error('routingPolicy classifierMinimumConfidence must be from 0 through 1')
  }
  if (source.maxCandidates !== undefined
    && (!Number.isSafeInteger(source.maxCandidates) || source.maxCandidates < 1 || source.maxCandidates > 8)) {
    throw new Error('routingPolicy maxCandidates must be from 1 through 8')
  }
  const routesSource = source.routes ?? source.classes ?? { default: {} }
  if (!routesSource || typeof routesSource !== 'object' || Array.isArray(routesSource)) throw new Error('routingPolicy routes must be an object')
  const routeNames = Object.keys(routesSource)
  if (!routeNames.length || routeNames.length > MAX_ROUTE_CLASSES || !routeNames.includes('default')) {
    throw new Error(`routingPolicy routes must contain default and at most ${MAX_ROUTE_CLASSES} routes`)
  }
  const defaultRoute = source.defaultRoute ?? source.default ?? 'default'
  identifier(defaultRoute, 'routingPolicy default route')
  if (!routeNames.includes(defaultRoute)) throw new Error(`routingPolicy default route ${defaultRoute} is not configured`)
  const routes = /** @type {AnyObject} */ ({})
  for (const routeName of routeNames) {
    identifier(routeName, 'routingPolicy route name')
    const route = routesSource[routeName]
    if (!route || typeof route !== 'object' || Array.isArray(route)) throw new Error(`routingPolicy route ${routeName} must be an object`)
    const routeAllowed = new Set(['rules', 'priority', 'selectors'])
    for (const key of Object.keys(route)) if (!routeAllowed.has(key)) throw new Error(`routingPolicy route ${routeName} has unknown field ${key}`)
    if (route.priority !== undefined && (!Number.isSafeInteger(route.priority) || route.priority < 0 || route.priority > MAX_ROUTE_CLASSES)) {
      throw new Error(`routingPolicy route ${routeName}.priority must be from 0 through ${MAX_ROUTE_CLASSES}`)
    }
    if (route.selectors !== undefined && (!Array.isArray(route.selectors) || route.selectors.length > MAX_RULES)) {
      throw new Error(`routingPolicy route ${routeName}.selectors must contain at most ${MAX_RULES} selectors`)
    }
    routes[routeName] = {
      ...(route.rules === undefined ? {} : { rules: normalizePolicyRule(route.rules, `routingPolicy route ${routeName}.rules`) }),
      ...(route.priority === undefined ? {} : { priority: route.priority }),
    }
  }
  const order = source.classificationOrder === undefined
    ? Object.keys(routes).filter(routeName => routeName !== defaultRoute).sort((left, right) => {
      const priority = (routes[left].priority ?? MAX_ROUTE_CLASSES) - (routes[right].priority ?? MAX_ROUTE_CLASSES)
      return priority || compareOrdinal(left, right)
    })
    : textList(source.classificationOrder, 'routingPolicy classificationOrder', MAX_ROUTE_CLASSES, 64)
  if (new Set(order).size !== order.length || order.some(routeName => !routeNames.includes(routeName) || routeName === defaultRoute)) {
    throw new Error('routingPolicy classificationOrder must list configured non-default routes once')
  }
  if (order.length !== routeNames.length - 1) throw new Error('routingPolicy classificationOrder must list every non-default route')
  return {
    version: 1,
    defaultRoute,
    classificationOrder: order,
    routes,
    ...(source.classifierMinimumConfidence === undefined
      ? {}
      : { classifierMinimumConfidence: source.classifierMinimumConfidence }),
  }
}

/** @param {AnyValue} routingPolicy @param {string} role @returns {AnyValue} */
function roleRoutingPolicy(routingPolicy, role) {
  return routingPolicy && typeof routingPolicy === 'object' && !Array.isArray(routingPolicy)
    && !routingPolicy.routes && !routingPolicy.classes && routingPolicy[role]
    ? routingPolicy[role]
    : routingPolicy
}

/** @param {AnyObject} policy @returns {string} */
function policyHash(policy) {
  return digest(policy)
}

/** @param {AnyValue} value @param {string} name @param {number} maximum @param {number} itemMaximum @returns {string[]} */
function collectStrings(value, name, maximum, itemMaximum = 256) {
  if (value === undefined || value === null) return []
  const items = Array.isArray(value) ? value : [value]
  if (items.length > maximum) return []
  return items.flatMap((item, index) => {
    if (typeof item === 'string') {
      const text = safeOptionalText(item, `${name}[${index}]`, itemMaximum)
      return text ? [text] : []
    }
    if (item && typeof item === 'object' && !Array.isArray(item) && typeof item.name === 'string') {
      const text = safeOptionalText(item.name, `${name}[${index}].name`, itemMaximum)
      return text ? [text] : []
    }
    return []
  })
}

/** @param {AnyValue} snapshot @returns {AnyObject} */
function normalizeTaskSnapshot(snapshot) {
  const source = snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot) ? snapshot : {}
  const labels = [...new Set(collectStrings(source.labels ?? source.issue?.labels, 'trustedTaskSnapshot.labels', MAX_LABELS, 128))].sort()
  const paths = [...new Set(collectStrings(source.paths ?? source.changedPaths ?? source.changedFilePaths, 'trustedTaskSnapshot.paths', MAX_PATHS, 512))].sort()
  const title = boundedEvidenceText(source.title ?? source.issue?.title)
  const body = boundedEvidenceText(source.body ?? source.issue?.body)
  const workflowStage = safeOptionalText(source.workflowStage ?? source.stageId, 'trustedTaskSnapshot.workflowStage', 64) || ''
  const explicitRoute = [
    source.routeClass, source.taskClass, source.profileRouteClass, source.targetRouteClass,
    source.profile?.routeClass, source.profile?.taskClass,
  ].map(value => safeOptionalText(value, 'trustedTaskSnapshot.routeClass', 64)).find(Boolean)
  const failure = source.failureEvidence && typeof source.failureEvidence === 'object' && !Array.isArray(source.failureEvidence)
    ? {
      category: safeOptionalText(source.failureEvidence.category, 'trustedTaskSnapshot.failureEvidence.category', 64) || '',
      code: safeOptionalText(source.failureEvidence.code, 'trustedTaskSnapshot.failureEvidence.code', 128) || '',
      class: safeOptionalText(source.failureEvidence.class ?? source.failureEvidence.failureClass, 'trustedTaskSnapshot.failureEvidence.class', 64) || '',
    }
    : {}
  return {
    labels,
    paths,
    title,
    body,
    workflowStage,
    ...(explicitRoute ? { explicitRoute } : {}),
    ...(Object.values(failure).some(Boolean) ? { failure } : {}),
  }
}

/** @param {string[]} values @param {string[]} matcher @param {string} mode @returns {boolean} */
function matchList(values, matcher, mode = 'any') {
  if (!values.length || !matcher.length) return false
  return mode === 'all' ? matcher.every(item => values.includes(item)) : matcher.some(item => values.includes(item))
}

/** @param {AnyObject} rule @param {AnyObject} evidence @returns {boolean} */
function matchRule(rule, evidence) {
  const matches = []
  if (rule.labelsAny) matches.push(matchList(evidence.labels, rule.labelsAny))
  if (rule.labelsAll) matches.push(matchList(evidence.labels, rule.labelsAll, 'all'))
  if (rule.pathPrefixes) matches.push(evidence.paths.some(/** @param {string} path */ path => rule.pathPrefixes.some(/** @param {string} prefix */ prefix => path.startsWith(prefix))))
  if (rule.pathContains) matches.push(evidence.paths.some(/** @param {string} path */ path => rule.pathContains.some(/** @param {string} part */ part => path.includes(part))))
  if (rule.extensions) matches.push(evidence.paths.some(/** @param {string} path */ path => rule.extensions.some(/** @param {string} extension */ extension => path.endsWith(extension))))
  if (rule.workflowStages) matches.push(rule.workflowStages.includes(evidence.workflowStage))
  if (rule.failureClasses) matches.push(rule.failureClasses.includes(evidence.failure?.class ?? ''))
  if (rule.titleIncludes) matches.push(rule.titleIncludes.some(/** @param {string} part */ part => evidence.title.toLowerCase().includes(part.toLowerCase())))
  if (rule.bodyIncludes) matches.push(rule.bodyIncludes.some(/** @param {string} part */ part => evidence.body.toLowerCase().includes(part.toLowerCase())))
  if (rule.any) matches.push(rule.any.some(/** @param {AnyObject} child */ child => matchRule(child, evidence)))
  if (rule.all) matches.push(rule.all.every(/** @param {AnyObject} child */ child => matchRule(child, evidence)))
  return matches.length > 0 && matches.some(Boolean)
}

/** @param {AnyValue} value @param {string[]} routes @param {number} minimumConfidence @returns {string|null} */
function classifierResult(value, routes, minimumConfidence) {
  if (typeof value === 'string') return routes.includes(value) ? value : null
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const taskClass = value.taskClass ?? value.routeClass
  if (typeof taskClass !== 'string' || !routes.includes(taskClass)) return null
  if (value.confidence === undefined) return taskClass
  if (typeof value.confidence === 'number') return value.confidence >= minimumConfidence ? taskClass : null
  if (value.confidence === 'high') return taskClass
  return null
}

/**
 * Classify one trusted WorkRequest with bounded, worker-neutral routing policy.
 * Invalid, unavailable, asynchronous, or low-confidence optional classifiers fall back to the configured default route.
 * @param {AnyObject} options
 * @returns {AnyObject}
 */
export function classifyWorkRequest({ workRequest, subjectState, subjectStateVersion, stateVersion, trustedTaskSnapshot, routingPolicy } = {}) {
  const identity = workRequestIdentity(workRequest)
  const exactVersion = exactStateVersion({ subjectState, subjectStateVersion, stateVersion })
  if (!SHA256.test(exactVersion || '')) throw new Error('Worker classification requires an exact subject state version')
  const rolePolicy = roleRoutingPolicy(routingPolicy, workRequest.role)
  const policy = normalizeRoutingPolicy(rolePolicy)
  let evidence
  try {
    evidence = normalizeTaskSnapshot(trustedTaskSnapshot)
  } catch {
    evidence = normalizeTaskSnapshot(undefined)
  }
  const evidenceHash = digest(evidence)
  const hash = policyHash(policy)
  const routes = Object.keys(policy.routes)
  const binding = { workRequestId: identity.requestId, role: identity.role, stateVersion: exactVersion }
  const explicit = evidence.explicitRoute
  if (explicit && routes.includes(explicit)) {
    return { version: 1, ...binding, taskClass: explicit, policyHash: hash, evidenceHash, source: 'trusted-route' }
  }
  for (const routeName of policy.classificationOrder) {
    if (policy.routes[routeName].rules && matchRule(policy.routes[routeName].rules, evidence)) {
      return { version: 1, ...binding, taskClass: routeName, policyHash: hash, evidenceHash, source: 'deterministic-rules' }
    }
  }
  const classifier = rolePolicy?.classifier
  if (typeof classifier === 'function') {
    try {
      const result = classifier({ workRequest, trustedTaskSnapshot: evidence, routingPolicy: policy })
      const asynchronous = result && typeof result.then === 'function'
      if (asynchronous) void Promise.resolve(result).catch(() => undefined)
      const selected = asynchronous
        ? null
        : classifierResult(result, routes, policy.classifierMinimumConfidence ?? 0.8)
      if (selected) return { version: 1, ...binding, taskClass: selected, policyHash: hash, evidenceHash, source: 'optional-classifier' }
    } catch {
      // Optional classification cannot stop a WorkRequest; use the deterministic default.
    }
  }
  return { version: 1, ...binding, taskClass: policy.defaultRoute, policyHash: hash, evidenceHash, source: 'default' }
}

/** @param {AnyValue} value @param {AnyObject|undefined} policy @returns {AnyObject} */
function validateClassification(value, policy) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.version !== 1
    || !SHA256.test(value.stateVersion || '')
    || !ID.test(value.taskClass || '')
    || !SHA256.test(value.policyHash || '')
    || !SHA256.test(value.evidenceHash || '')
    || !CLASSIFICATION_SOURCES.has(value.source)) {
    throw new Error('Worker classification v1 is invalid')
  }
  for (const key of Object.keys(value)) {
    if (!CLASSIFICATION_FIELDS.has(key)) throw new Error(`Worker classification has unknown field ${key}`)
  }
  for (const key of CLASSIFICATION_FIELDS) {
    if (!Object.hasOwn(value, key)) throw new Error(`Worker classification is missing required field ${key}`)
  }
  const identity = workRequestIdentity({ requestId: value.workRequestId, role: value.role })
  if (policy && !Object.hasOwn(policy.routes, value.taskClass)) {
    throw new Error('Worker classification taskClass is not configured by routingPolicy')
  }
  return {
    version: 1,
    workRequestId: identity.requestId,
    role: identity.role,
    stateVersion: value.stateVersion,
    taskClass: value.taskClass,
    policyHash: value.policyHash,
    evidenceHash: value.evidenceHash,
    source: value.source,
  }
}

/** @param {AnyValue} workRequest @returns {{requestId: string, role: string}} */
function workRequestIdentity(workRequest) {
  if (!workRequest || typeof workRequest !== 'object' || Array.isArray(workRequest)
    || typeof workRequest.requestId !== 'string' || !workRequest.requestId.trim()
    || typeof workRequest.role !== 'string' || !WORKER_ROUTE_ROLES.has(workRequest.role)
    || !ID.test(workRequest.role)) {
    throw new Error('WorkerRouteDecision requires a valid WorkRequest id and role')
  }
  return { requestId: boundedText(workRequest.requestId, 'WorkRequest requestId', 160), role: workRequest.role }
}

/** Resolve one exact subject state version and reject conflicting aliases.
 * @param {AnyObject} options
 * @returns {AnyValue}
 */
function exactStateVersion({ subjectState, subjectStateVersion, stateVersion }) {
  const candidates = [subjectStateVersion, stateVersion]
  if (typeof subjectState === 'string') candidates.push(subjectState)
  if (subjectState && typeof subjectState === 'object') {
    candidates.push(subjectState.stateVersion, subjectState.version)
  }
  const defined = candidates.filter(candidate => candidate !== undefined)
  if (new Set(defined).size > 1) throw new Error('Exact subject state version inputs must agree')
  return defined[0]
}

/** Create a strict durable WorkerRouteDecision v1 without selecting a concrete Worker.
 * @param {AnyObject} options
 * @returns {AnyObject}
 */
export function createWorkerRouteDecision({ workRequest, subjectState, subjectStateVersion, stateVersion, classification, routingPolicy } = {}) {
  const identity = workRequestIdentity(workRequest)
  const version = exactStateVersion({ subjectState, subjectStateVersion, stateVersion })
  if (!SHA256.test(version || '')) throw new Error('WorkerRouteDecision stateVersion must be a SHA-256 digest')
  const policy = routingPolicy === undefined ? undefined : normalizeRoutingPolicy(roleRoutingPolicy(routingPolicy, identity.role))
  const normalized = validateClassification(classification, policy)
  if (normalized.workRequestId !== identity.requestId || normalized.role !== identity.role) {
    throw new Error('Worker classification does not match the WorkRequest')
  }
  if (normalized.stateVersion !== version) {
    throw new Error('Worker classification does not match the exact subject state')
  }
  if (policy && normalized.policyHash !== policyHash(policy)) {
    throw new Error('WorkerRouteDecision policyHash does not match routingPolicy')
  }
  return {
    version: 1,
    workRequestId: identity.requestId,
    role: identity.role,
    stateVersion: version,
    taskClass: normalized.taskClass,
    policyHash: normalized.policyHash,
    evidenceHash: normalized.evidenceHash,
  }
}

/** Validate one durable WorkerRouteDecision and optionally bind it to its WorkRequest and state version. */
/** @param {AnyValue} value @param {AnyObject} options @returns {AnyObject} */
export function parseWorkerRouteDecision(value, { workRequest, subjectState, subjectStateVersion, stateVersion, routingPolicy } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('WorkerRouteDecision must be an object')
  for (const key of Object.keys(value)) if (!DECISION_FIELDS.has(key)) throw new Error(`WorkerRouteDecision has unknown field ${key}`)
  for (const key of DECISION_FIELDS) if (!Object.hasOwn(value, key)) throw new Error(`WorkerRouteDecision is missing required field ${key}`)
  if (value.version !== 1) throw new Error('WorkerRouteDecision version must be 1')
  const identity = workRequestIdentity({ requestId: value.workRequestId, role: value.role })
  if (!SHA256.test(value.stateVersion || '')) throw new Error('WorkerRouteDecision stateVersion must be a SHA-256 digest')
  if (!ID.test(value.taskClass || '') || !SHA256.test(value.policyHash || '') || !SHA256.test(value.evidenceHash || '')) {
    throw new Error('WorkerRouteDecision fields are invalid')
  }
  const policy = routingPolicy === undefined ? undefined : normalizeRoutingPolicy(roleRoutingPolicy(routingPolicy, identity.role))
  if (policy && !Object.hasOwn(policy.routes, value.taskClass)) {
    throw new Error('WorkerRouteDecision taskClass is not configured by routingPolicy')
  }
  if (policy && value.policyHash !== policyHash(policy)) {
    throw new Error('WorkerRouteDecision policyHash does not match routingPolicy')
  }
  const expectedStateVersion = exactStateVersion({ subjectState, subjectStateVersion, stateVersion })
  if (expectedStateVersion !== undefined && value.stateVersion !== expectedStateVersion) {
    throw new Error('WorkerRouteDecision stateVersion does not match the subject')
  }
  if (workRequest) {
    const expected = workRequestIdentity(workRequest)
    if (identity.requestId !== expected.requestId || identity.role !== expected.role) {
      throw new Error('WorkerRouteDecision does not match the WorkRequest')
    }
  }
  return {
    version: 1,
    workRequestId: identity.requestId,
    role: identity.role,
    stateVersion: value.stateVersion,
    taskClass: value.taskClass,
    policyHash: value.policyHash,
    evidenceHash: value.evidenceHash,
  }
}

/** Create the controller-owned routing execution envelope transported to a Worker. */
/** @param {AnyObject} options @returns {AnyObject} */
export function createWorkerRoutingExecution({ routingAttemptId, ...options } = {}) {
  if (typeof routingAttemptId !== 'string' || !ROUTING_ATTEMPT_ID.test(routingAttemptId)) {
    throw new Error('routingAttemptId must be a bounded identifier')
  }
  return {
    version: 1,
    routingAttemptId,
    routeDecision: classifyAndCreateWorkerRouteDecision(options),
  }
}

/** Parse and bind a controller-owned routing execution envelope to the live WorkRequest and subject. */
/** @param {AnyValue} value @param {AnyObject} options @returns {AnyObject} */
export function parseWorkerRoutingExecution(value, options = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Worker routing execution must be an object')
  for (const key of Object.keys(value)) if (!ROUTING_EXECUTION_FIELDS.has(key)) throw new Error(`Worker routing execution has unknown field ${key}`)
  for (const key of ROUTING_EXECUTION_FIELDS) if (!Object.hasOwn(value, key)) throw new Error(`Worker routing execution is missing required field ${key}`)
  if (value.version !== 1 || typeof value.routingAttemptId !== 'string' || !ROUTING_ATTEMPT_ID.test(value.routingAttemptId)) {
    throw new Error('Worker routing execution version or routingAttemptId is invalid')
  }
  return {
    version: 1,
    routingAttemptId: value.routingAttemptId,
    routeDecision: parseWorkerRouteDecision(value.routeDecision, options),
  }
}

/** @param {AnyValue} value @returns {string} */
function routingRecordKey(value) {
  return digest(value)
}

/** @param {string} value @returns {string|null} */
function trustedActionsGeneration(value) {
  const runId = process.env.GITHUB_RUN_ID
  const runAttempt = process.env.GITHUB_RUN_ATTEMPT
  const runIdText = runId || ''
  const runAttemptText = runAttempt || ''
  if (!/^\d+$/.test(runIdText) || !/^\d+$/.test(runAttemptText)
    || Number.parseInt(runIdText, 10) < 1 || Number.parseInt(runAttemptText, 10) < 1) return null
  const runUrl = process.env.RUN_URL || process.env.GITHUB_RUN_URL
  if (runUrl !== undefined && !new RegExp(`/actions/runs/${runIdText}(?:$|[?#])`).test(runUrl)) return null
  return `actions-${runIdText}-${runAttemptText}-${value}`
}

/** @param {string} recordPath @returns {Promise<AnyObject|null>} */
async function readRoutingRecord(recordPath) {
  try {
    const value = JSON.parse(await readFile(recordPath, 'utf8'))
    if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== ROUTING_RECORD_VERSION) {
      throw new Error('Local Worker routing record is invalid')
    }
    return value
  } catch (error) {
    if (/** @type {any} */ (error)?.code === 'ENOENT') return null
    throw error
  }
}

/**
 * Classify and persist Worker routing on the target machine. Controller and
 * GitHub event payloads are intentionally absent from this authority path.
 * @param {AnyObject} options
 * @returns {Promise<AnyObject>}
 */
export async function loadOrCreateLocalWorkerRoutingExecution({
  stateRoot,
  workRequest,
  subjectState,
  subjectStateVersion,
  stateVersion,
  trustedTaskSnapshot,
  routingPolicy,
} = {}) {
  const routeDecision = classifyAndCreateWorkerRouteDecision({
    workRequest,
    subjectState,
    subjectStateVersion,
    stateVersion,
    trustedTaskSnapshot,
    routingPolicy,
  })
  const identity = {
    workRequestId: routeDecision.workRequestId,
    role: routeDecision.role,
    stateVersion: routeDecision.stateVersion,
    policyHash: routeDecision.policyHash,
    evidenceHash: routeDecision.evidenceHash,
  }
  const key = routingRecordKey(identity)
  const actionGeneration = trustedActionsGeneration(key.slice(0, 16))
  const generationSource = actionGeneration || `local-${key}`
  /** @param {AnyObject|null} existing @returns {AnyObject} */
  const create = existing => {
    const sameGeneration = existing
      && existing.key === key
      && existing.generationSource === generationSource
      && existing.routeDecision
    const generation = sameGeneration ? existing.generation : (existing?.generation || 0) + 1
    const routingAttemptId = `local-${key.slice(0, 24)}-g${generation}`
    return {
      version: ROUTING_RECORD_VERSION,
      key,
      generation,
      generationSource,
      routingAttemptId,
      routeDecision,
    }
  }
  if (typeof stateRoot !== 'string' || !stateRoot.trim()) return create(null)
  const directory = join(stateRoot, 'worker-routing')
  const recordPath = join(directory, `${key}.json`)
  await mkdir(directory, { recursive: true })
  return withCapacityRegistryLock(stateRoot, async () => {
    const existing = await readRoutingRecord(recordPath)
    const record = create(existing)
    if (!existing || existing.generation !== record.generation || existing.generationSource !== record.generationSource) {
      const temporaryPath = `${recordPath}.${process.pid}.${Date.now()}.tmp`
      await writeFile(temporaryPath, `${JSON.stringify(record)}\n`, 'utf8')
      await rename(temporaryPath, recordPath)
    }
    return {
      version: 1,
      routingAttemptId: record.routingAttemptId,
      routeDecision: parseWorkerRouteDecision(record.routeDecision, {
        workRequest,
        subjectState,
        subjectStateVersion,
        stateVersion,
        routingPolicy,
      }),
    }
  })
}

/** Serialize a validated decision with stable key ordering for durable transport. */
/** @param {AnyValue} value @returns {string} */
export function serializeWorkerRouteDecision(value) {
  return canonicalJson(parseWorkerRouteDecision(value))
}

/** Render a controller-owned durable decision record for a comment or file. */
/** @param {AnyValue} value @returns {string} */
export function workerRouteDecisionBody(value) {
  return `${ROUTE_DECISION_MARKER}\n${serializeWorkerRouteDecision(value)}\n${ROUTE_DECISION_TRAILER}`
}

/** Parse one durable decision record and optionally verify its WorkRequest and exact subject state. */
/** @param {AnyValue} body @param {AnyObject} options @returns {AnyObject} */
export function parseWorkerRouteDecisionBody(body, options = {}) {
  if (typeof body !== 'string') throw new Error('WorkerRouteDecision body must be text')
  const markerIndex = body.indexOf(ROUTE_DECISION_MARKER)
  const trailerIndex = body.indexOf(ROUTE_DECISION_TRAILER)
  if (markerIndex !== 0
    || markerIndex !== body.lastIndexOf(ROUTE_DECISION_MARKER)
    || trailerIndex <= markerIndex
    || trailerIndex !== body.lastIndexOf(ROUTE_DECISION_TRAILER)
    || trailerIndex + ROUTE_DECISION_TRAILER.length !== body.length) {
    throw new Error('WorkerRouteDecision body must contain one exact durable v1 record with no surrounding content')
  }
  const start = markerIndex + ROUTE_DECISION_MARKER.length
  const end = trailerIndex
  const serialized = body.slice(start, end).trim()
  rejectDuplicateJsonMembers(serialized)
  let value
  try {
    value = JSON.parse(serialized)
  } catch (error) {
    throw new Error(`WorkerRouteDecision body is not valid JSON: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
  }
  return parseWorkerRouteDecision(value, options)
}

/** Classify and bind one exact WorkRequest state in one deterministic operation. */
/** @param {AnyObject} options @returns {AnyObject} */
export function classifyAndCreateWorkerRouteDecision(options = {}) {
  const classification = classifyWorkRequest(options)
  return createWorkerRouteDecision({ ...options, classification })
}
