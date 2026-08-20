// @ts-check

import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROLE_NAMES = ['change', 'review', 'maintenance']
const ROUTING_ROLE_NAMES = ['change', 'review']
const MAX_ROUTING_ROUTES = 32
const MAX_ROUTE_SELECTORS = 16
const MAX_ROUTING_TAGS = 16
const DEFAULTS_PATH = fileURLToPath(new URL('../ops/config.defaults.json', import.meta.url))
const REMOVED_FIELDS = [
  'schemaVersion', 'configRevision', 'credentialRevision', 'repositories',
  'maintenanceWorkers', 'maintenanceReviewWorker',
]

/** @typedef {any} JsonValue Recursive JSON values are narrowed by the strict runtime schema after defaults are merged. */
/** @typedef {Record<string, any>} MachineConfig Runtime schema variants are validated before Adapter use, so a single static object type cannot express their mutable normalization. */

/** Return a recursively key-sorted JSON value. */
/** @param {JsonValue} value @returns {JsonValue} */
function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalValue(value[key])]))
  }
  return value
}

/** Merge JSON objects recursively while replacing arrays and scalar values. */
/** @param {JsonValue} base @param {JsonValue} override @returns {JsonValue} */
function mergeObjects(base, override) {
  if (!base || typeof base !== 'object' || Array.isArray(base)
    || !override || typeof override !== 'object' || Array.isArray(override)) {
    return structuredClone(override)
  }
  const merged = structuredClone(base)
  for (const [key, value] of Object.entries(override)) {
    merged[key] = key in merged ? mergeObjects(merged[key], value) : structuredClone(value)
  }
  return merged
}

/** Expand the only supported configuration path token. */
/** @param {JsonValue} value @param {string} configurationDirectory @returns {JsonValue} */
function expandConfigurationDirectory(value, configurationDirectory) {
  if (Array.isArray(value)) return value.map(item => expandConfigurationDirectory(item, configurationDirectory))
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      key, expandConfigurationDirectory(item, configurationDirectory),
    ]))
  }
  if (typeof value !== 'string' || !value.includes('${CONFIG_DIR}')) return value
  const expanded = value.replaceAll('${CONFIG_DIR}', configurationDirectory)
  return isAbsolute(expanded) ? resolve(expanded) : expanded
}

/** Normalize and validate a GitHub owner/repository identity for comparisons. */
/** @param {unknown} value @param {string} field @returns {string} */
function canonicalRepository(value, field) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)) {
    throw new Error(`${field} must be owner/repository`)
  }
  return value.toLowerCase()
}

/** Return the Worker ids assigned to one role. */
/** @param {MachineConfig} config @param {string} role @returns {string[]} */
export function roleWorkerIds(config, role) {
  if (!ROLE_NAMES.includes(role)) throw new Error(`Unknown agent role ${role}`)
  const workers = config?.operations?.roles?.[role]?.workers
  const maximum = 8
  if (!Array.isArray(workers) || workers.length < 1 || workers.length > maximum
    || workers.some(workerId => typeof workerId !== 'string' || !workerId.trim())
    || new Set(workers).size !== workers.length) {
    throw new Error(`operations.roles.${role}.workers must contain 1 through 8 unique Worker ids`)
  }
  return [...workers]
}

/** Validate a bounded routing identifier. */
/** @param {unknown} value @param {string} field @returns {string} */
function routingIdentifier(value, field) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    throw new Error(`${field} must be a non-empty routing identifier`)
  }
  return value
}

/** Return a route name from the optional PR1 route decision input. */
/** @param {unknown} routeDecision @returns {string} */
function routeNameFromDecision(routeDecision) {
  if (routeDecision === undefined || routeDecision === null) return 'default'
  if (typeof routeDecision === 'string') return routingIdentifier(routeDecision, 'route')
  if (typeof routeDecision !== 'object' || Array.isArray(routeDecision)) throw new Error('routeDecision must be an object or route name')
  const decision = /** @type {Record<string, any>} */ (routeDecision)
  const route = decision.route ?? decision.taskClass ?? 'default'
  return routingIdentifier(route, 'routeDecision.route')
}

/** Normalize bounded Worker-local routing metadata. */
/** @param {MachineConfig} worker @param {string} workerId */
function normalizeWorkerRoutingMetadata(worker, workerId) {
  const capacityGroup = worker.capacityGroup ?? workerId
  worker.capacityGroup = routingIdentifier(capacityGroup, `workers.${workerId}.capacityGroup`)
  const tags = worker.routingTags ?? []
  if (!Array.isArray(tags) || tags.length > MAX_ROUTING_TAGS || new Set(tags).size !== tags.length
    || tags.some(tag => typeof tag !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(tag))) {
    throw new Error(`workers.${workerId}.routingTags must contain at most ${MAX_ROUTING_TAGS} unique tags`)
  }
  worker.routingTags = [...tags]
}

/** Resolve one route graph to a deduplicated deterministic Worker id list. */
/** @param {MachineConfig} config @param {string} role @param {string} routeName @param {string[]} visiting @returns {string[]} */
function resolveRouteCandidates(config, role, routeName, visiting = []) {
  const routes = config?.operations?.routing?.[role]?.routes
  const route = routes?.[routeName]
  if (!route) throw new Error(`Unknown ${role} route ${routeName}`)
  if (visiting.includes(routeName)) throw new Error(`operations.routing.${role}.routes contains a cycle: ${[...visiting, routeName].join(' -> ')}`)
  const roleWorkers = roleWorkerIds(config, role)
  const result = []
  for (const selector of route.selectors) {
    if (selector.worker !== undefined) result.push(selector.worker)
    else if (selector.allTags !== undefined) {
      const matching = roleWorkers
        .filter(workerId => selector.allTags.every(/** @param {any} tag */ tag => config.workers[workerId].routingTags.includes(tag)))
        .sort((left, right) => left.localeCompare(right))
      result.push(...matching)
    } else if (selector.route !== undefined) {
      result.push(...resolveRouteCandidates(config, role, selector.route, [...visiting, routeName]))
    }
  }
  return [...new Set(result)]
}

/** Validate and normalize PR1 role routing configuration. */
/** @param {MachineConfig} config @returns {void} */
export function validateRoutingConfig(config) {
  const routing = config.operations.routing
  if (!routing || typeof routing !== 'object' || Array.isArray(routing)) throw new Error('operations.routing must be an object')
  const unknownRoles = Object.keys(routing).filter(role => !ROUTING_ROLE_NAMES.includes(role))
  if (unknownRoles.length) throw new Error(`operations.routing contains unsupported role(s): ${unknownRoles.join(', ')}`)
  for (const role of ROUTING_ROLE_NAMES) {
    const roleRouting = routing[role]
    if (!roleRouting || typeof roleRouting !== 'object' || Array.isArray(roleRouting)) throw new Error(`operations.routing.${role} must be an object`)
    const unknownRoleFields = Object.keys(roleRouting).filter(field => !['maxCandidates', 'routes'].includes(field))
    if (unknownRoleFields.length) throw new Error(`operations.routing.${role} contains unsupported field(s): ${unknownRoleFields.join(', ')}`)
    const maxCandidates = roleRouting.maxCandidates ?? 8
    if (!Number.isSafeInteger(maxCandidates) || maxCandidates < 1 || maxCandidates > 8) {
      throw new Error(`operations.routing.${role}.maxCandidates must be an integer from 1 through 8`)
    }
    roleRouting.maxCandidates = maxCandidates
    const routes = roleRouting.routes
    if (!routes || typeof routes !== 'object' || Array.isArray(routes)) throw new Error(`operations.routing.${role}.routes must be an object`)
    const routeNames = Object.keys(routes)
    if (!routeNames.length || routeNames.length > MAX_ROUTING_ROUTES || !routeNames.includes('default')) {
      throw new Error(`operations.routing.${role}.routes must contain default and at most ${MAX_ROUTING_ROUTES} routes`)
    }
    for (const routeName of routeNames) {
      routingIdentifier(routeName, `operations.routing.${role}.routes name`)
      const route = routes[routeName]
      if (!route || typeof route !== 'object' || Array.isArray(route)) throw new Error(`operations.routing.${role}.routes.${routeName} must be an object`)
      const unknownRouteFields = Object.keys(route).filter(field => field !== 'selectors')
      if (unknownRouteFields.length) throw new Error(`operations.routing.${role}.routes.${routeName} contains unsupported field(s): ${unknownRouteFields.join(', ')}`)
      if (!Array.isArray(route.selectors) || !route.selectors.length || route.selectors.length > MAX_ROUTE_SELECTORS) {
        throw new Error(`operations.routing.${role}.routes.${routeName}.selectors must contain 1 through ${MAX_ROUTE_SELECTORS} selectors`)
      }
      for (const [index, selector] of route.selectors.entries()) {
        if (!selector || typeof selector !== 'object' || Array.isArray(selector)) throw new Error(`operations.routing.${role}.routes.${routeName}.selectors[${index}] must be an object`)
        const unknownSelectorFields = Object.keys(selector).filter(field => !['worker', 'allTags', 'route'].includes(field))
        if (unknownSelectorFields.length) throw new Error(`operations.routing.${role}.routes.${routeName}.selectors[${index}] contains unsupported field(s): ${unknownSelectorFields.join(', ')}`)
        const kinds = ['worker', 'allTags', 'route'].filter(kind => selector[kind] !== undefined)
        if (kinds.length !== 1) throw new Error(`operations.routing.${role}.routes.${routeName}.selectors[${index}] must choose one selector kind`)
        const kind = kinds[0]
        if (kind === 'worker') {
          routingIdentifier(selector.worker, `operations.routing.${role}.routes.${routeName}.selectors[${index}].worker`)
          if (!roleWorkerIds(config, role).includes(selector.worker)) throw new Error(`Worker ${selector.worker} is not admitted to the ${role} role`)
        } else if (kind === 'route') {
          routingIdentifier(selector.route, `operations.routing.${role}.routes.${routeName}.selectors[${index}].route`)
          if (!routeNames.includes(selector.route)) throw new Error(`Unknown ${role} route ${selector.route}`)
        } else {
          if (!Array.isArray(selector.allTags) || !selector.allTags.length || selector.allTags.length > MAX_ROUTING_TAGS
            || new Set(selector.allTags).size !== selector.allTags.length
            || selector.allTags.some(/** @param {any} tag */ tag => typeof tag !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(tag))) {
            throw new Error(`operations.routing.${role}.routes.${routeName}.selectors[${index}].allTags must contain 1 through ${MAX_ROUTING_TAGS} unique tags`)
          }
        }
      }
    }
    for (const routeName of routeNames) {
      const candidates = resolveRouteCandidates(config, role, routeName)
      if (!candidates.length) throw new Error(`operations.routing.${role}.routes.${routeName} resolves to no admitted Worker`)
      const allowed = new Set(roleWorkerIds(config, role))
      if (candidates.some(workerId => !allowed.has(workerId))) throw new Error(`operations.routing.${role}.routes.${routeName} resolves outside the ${role} role pool`)
      if (role === 'review' && candidates.some(workerId => !config.workers[workerId].capabilities?.hardReadOnlyReview)) {
        throw new Error(`operations.routing.review.routes.${routeName} includes a Worker without hard read-only isolation`)
      }
    }
  }
}

/** Resolve an admitted, bounded, deterministic Worker candidate list for a route. */
/** @param {{config: MachineConfig, role: string, routeDecision?: unknown}} options @returns {string[]} */
export function resolveWorkerCandidates({ config, role, routeDecision }) {
  if (!ROUTING_ROLE_NAMES.includes(role)) throw new Error(`Worker routing is not available for ${role}`)
  if (config?.operations?.routing === undefined) return [roleWorkerIds(config, role)[0]]
  validateRoutingConfig(config)
  const candidates = resolveRouteCandidates(config, role, routeNameFromDecision(routeDecision))
  const allowed = new Set(roleWorkerIds(config, role))
  return candidates.filter(workerId => allowed.has(workerId)).slice(0, config.operations.routing[role].maxCandidates)
}

/** @param {MachineConfig} worker @param {string} role */
function implementedCapabilities(worker, role) {
  if (worker.adapter === 'codex-app') {
    if (role !== 'review') throw new Error('codex-app can only serve the review role')
    return { skills: ['github-pr-review', 'github-repository-supervision', 'agent-readiness-canary'], hardReadOnlyReview: true, trustDomain: role }
  }
  if (worker.adapter === 'dsh-web') {
    if (role === 'maintenance') throw new Error('dsh-web cannot serve the maintenance role')
    if (role === 'review') throw new Error('dsh-web does not provide hard read-only review isolation')
    return { skills: ['github-issue-work', 'github-pr-repair', 'agent-readiness-canary'], hardReadOnlyReview: false, trustDomain: role }
  }
  if (['opencode-cli', 'claude-code-cli'].includes(worker.adapter)) {
    if (role === 'review') return { skills: ['github-pr-review', 'github-repository-supervision', 'agent-readiness-canary'], hardReadOnlyReview: true, trustDomain: role }
    if (role === 'maintenance') return { skills: ['controller-maintenance-repair', 'agent-readiness-canary'], hardReadOnlyReview: false, trustDomain: role }
    return { skills: ['github-issue-work', 'github-pr-repair', 'agent-readiness-canary'], hardReadOnlyReview: false, trustDomain: role }
  }
  if (worker.adapter === 'command-json') {
    if (role === 'review') throw new Error('command-json cannot serve the review role without verifiable read-only isolation')
    return role === 'maintenance'
      ? { skills: ['controller-maintenance-repair', 'agent-readiness-canary'], hardReadOnlyReview: false, trustDomain: role }
      : { skills: ['github-issue-work', 'github-pr-repair', 'agent-readiness-canary'], hardReadOnlyReview: false, trustDomain: role }
  }
  throw new Error(`Unknown Worker Adapter ${String(worker.adapter)}`)
}

/** @param {MachineConfig} input */
function rejectRemovedFields(input) {
  for (const field of REMOVED_FIELDS) {
    if (Object.hasOwn(input, field)) throw new Error(`runner configuration field ${field} was removed; use role Worker bindings and credentialGeneration`)
  }
  if (Object.hasOwn(input?.operations || {}, 'schemaVersion')) {
    throw new Error('runner configuration field operations.schemaVersion was removed')
  }
  for (const mapping of input?.operations?.repositoryMappings || []) {
    if (Object.hasOwn(mapping, 'changeWorker') || Object.hasOwn(mapping, 'reviewWorker')) {
      throw new Error('repositoryMappings Worker fields were removed; use operations.roles.<role>.workers')
    }
  }
  for (const [workerId, worker] of Object.entries(input?.workers || {})) {
    if (Object.hasOwn(worker, 'projectCwd')) {
      throw new Error(`workers.${workerId}.projectCwd was removed; Codex projects are derived per repository from operations.stateRoot`)
    }
    if (Object.hasOwn(worker, 'mode') || Object.hasOwn(worker, 'capabilities') || Object.hasOwn(worker, 'githubLogin')) {
      throw new Error(`workers.${workerId} role, capabilities, and GitHub identity are derived from its role binding`)
    }
  }
}

/** Resolve defaults and derive role-owned Worker properties from one public document. */
/** @param {{defaults: MachineConfig, input: MachineConfig, configurationPath: string}} options @returns {MachineConfig} */
export function resolveMachineConfig({ defaults, input, configurationPath }) {
  rejectRemovedFields(input)
  const configurationDirectory = dirname(resolve(configurationPath))
  const config = /** @type {MachineConfig} */ (expandConfigurationDirectory(mergeObjects(defaults, input), configurationDirectory))
  const mappings = config?.operations?.repositoryMappings
  if (!Array.isArray(mappings) || mappings.length === 0) {
    throw new Error('runner configuration operations.repositoryMappings must be a non-empty array')
  }
  const controllerRepository = canonicalRepository(
    config?.operations?.controller?.repository,
    'operations.controller.repository',
  )
  config.repositories = mappings.map(mapping => mapping?.repository)
  const mappingRepositories = []
  for (const repository of /** @type {unknown[]} */ (config.repositories)) {
    mappingRepositories.push(canonicalRepository(repository, 'operations.repositoryMappings.repository'))
  }
  if (mappingRepositories.some(repository => repository === controllerRepository)) {
    throw new Error('operations.repositoryMappings must not target the controller repository')
  }
  if (new Set(mappingRepositories).size !== mappingRepositories.length) {
    throw new Error('runner configuration repositoryMappings must not contain duplicate repositories')
  }
  const assigned = new Map()
  for (const role of ROLE_NAMES) {
    for (const workerId of roleWorkerIds(config, role)) {
      if (assigned.has(workerId)) throw new Error(`Worker ${workerId} cannot serve both ${assigned.get(workerId)} and ${role} trust domains`)
      const worker = config?.workers?.[workerId]
      if (!worker || typeof worker !== 'object' || Array.isArray(worker)) throw new Error(`Unknown ${role} Worker ${workerId}`)
      assigned.set(workerId, role)
      worker.mode = role
      worker.capabilities = implementedCapabilities(worker, role)
      if (worker.adapter === 'opencode-cli' && worker.executable === undefined) worker.executable = 'opencode'
      if (worker.adapter === 'claude-code-cli' && worker.executable === undefined) worker.executable = 'claude'
      if (role === 'review' && ['opencode-cli', 'claude-code-cli'].includes(worker.adapter) && worker.gitExecutable === undefined) {
        worker.gitExecutable = config.gitExecutable
      }
      if (role === 'maintenance') {
        if (worker.credentialIsolationDir === undefined) worker.credentialIsolationDir = join(config.operations.stateRoot, 'credentials', workerId)
        worker.githubLogin = config.github?.login
      }
      normalizeWorkerRoutingMetadata(worker, workerId)
    }
  }
  const unassigned = Object.keys(config.workers || {}).filter(workerId => !assigned.has(workerId))
  if (unassigned.length) throw new Error(`Every Worker must have exactly one role binding: ${unassigned.join(', ')}`)
  if (config.operations.routing === undefined) config.operations.routing = {}
  if (typeof config.operations.routing !== 'object' || Array.isArray(config.operations.routing)) throw new Error('operations.routing must be an object')
  for (const role of ROUTING_ROLE_NAMES) {
    if (config.operations.routing[role] === undefined) {
      config.operations.routing[role] = {
        routes: { default: { selectors: [{ worker: roleWorkerIds(config, role)[0] }] } },
      }
    }
  }
  for (const role of Object.keys(config.operations.routing)) {
    if (!ROUTING_ROLE_NAMES.includes(role)) throw new Error(`operations.routing does not support the ${role} role in PR1`)
  }
  validateRoutingConfig(config)
  const hashInput = structuredClone(config)
  delete hashInput.$schema
  delete hashInput.credentialGeneration
  delete hashInput.configurationHash
  config.configurationHash = createHash('sha256').update(JSON.stringify(canonicalValue(hashInput))).digest('hex')
  return config
}

/** Load built-in defaults and one machine-local configuration file. */
/** @param {string} configurationPath @returns {Promise<MachineConfig>} */
export async function readMachineConfig(configurationPath) {
  const [defaultsText, inputText] = await Promise.all([
    readFile(DEFAULTS_PATH, 'utf8'), readFile(configurationPath, 'utf8'),
  ])
  let defaults
  let input
  try { defaults = JSON.parse(defaultsText) } catch (error) { throw new Error(`built-in configuration defaults are invalid JSON: ${error instanceof Error ? error.message : String(error)}`) }
  try { input = JSON.parse(inputText) } catch (error) { throw new Error(`runner configuration is not valid JSON: ${error instanceof Error ? error.message : String(error)}`) }
  return resolveMachineConfig({ defaults, input, configurationPath })
}
