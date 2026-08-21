// @ts-check

import { createHash } from 'node:crypto'

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
const DECISION_FIELDS = new Set([
  'version', 'workRequestId', 'role', 'stateVersion', 'taskClass', 'policyHash', 'evidenceHash',
])
const CLASSIFICATION_SOURCES = new Set([
  'trusted-route', 'deterministic-rules', 'optional-classifier', 'default',
])
const CLASSIFICATION_FIELDS = new Set([
  'version', 'workRequestId', 'role', 'stateVersion', 'taskClass', 'policyHash', 'evidenceHash', 'source',
])
const WORKER_ROUTE_ROLES = new Set(['change', 'review'])

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

/** Serialize a validated decision with stable key ordering for durable transport. */
/** @param {AnyValue} value @returns {string} */
export function serializeWorkerRouteDecision(value) {
  return canonicalJson(parseWorkerRouteDecision(value))
}

/** Classify and bind one exact WorkRequest state in one deterministic operation. */
/** @param {AnyObject} options @returns {AnyObject} */
export function classifyAndCreateWorkerRouteDecision(options = {}) {
  const classification = classifyWorkRequest(options)
  return createWorkerRouteDecision({ ...options, classification })
}

/**
 * Derive the Worker-owned routing execution identity from trusted local input.
 * A supplied decision must match fresh local classification. The returned
 * identity contains no concrete Worker, provider, or model.
 * @param {AnyObject} options
 * @returns {AnyObject}
 */
export function createLocalWorkerRoutingExecution({ routeDecision, ...options } = {}) {
  if (Object.prototype.hasOwnProperty.call(options, 'generation')) {
    throw new Error('local routing generation is provider-owned')
  }
  const accepted = new Set(['workRequest', 'subjectState', 'subjectStateVersion', 'stateVersion', 'trustedTaskSnapshot', 'routingPolicy'])
  for (const key of Object.keys(options)) {
    if (!accepted.has(key)) throw new Error(`local routing option ${key} is not recognized`)
  }
  const localDecision = classifyAndCreateWorkerRouteDecision(options)
  const decision = routeDecision === undefined
    ? localDecision
    : parseWorkerRouteDecision(routeDecision, options)
  if (routeDecision !== undefined && JSON.stringify(decision) !== JSON.stringify(localDecision)) {
    throw new Error('WorkerRouteDecision does not match the local trusted routing authority')
  }
  const identity = {
    workRequestId: decision.workRequestId,
    role: decision.role,
    stateVersion: decision.stateVersion,
    taskClass: decision.taskClass,
    policyHash: decision.policyHash,
    evidenceHash: decision.evidenceHash,
  }
  const routingAttemptId = `local-${digest(identity).slice(0, 64)}`
  return { version: 1, routingAttemptId, routeDecision: decision }
}
