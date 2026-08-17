// @ts-check

import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROLE_NAMES = ['change', 'review', 'maintenance']
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

/** Return the Worker ids assigned to one role. */
/** @param {MachineConfig} config @param {string} role @returns {string[]} */
export function roleWorkerIds(config, role) {
  if (!ROLE_NAMES.includes(role)) throw new Error(`Unknown agent role ${role}`)
  const workers = config?.operations?.roles?.[role]?.workers
  const maximum = role === 'maintenance' ? 8 : 1
  if (!Array.isArray(workers) || workers.length < 1 || workers.length > maximum
    || workers.some(workerId => typeof workerId !== 'string' || !workerId.trim())
    || new Set(workers).size !== workers.length) {
    throw new Error(`operations.roles.${role}.workers must contain ${role === 'maintenance' ? '1 through 8' : 'exactly one'} unique Worker id`)
  }
  return [...workers]
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
  config.repositories = mappings.map(mapping => mapping?.repository)
  if (new Set(config.repositories).size !== config.repositories.length) {
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
    }
  }
  const unassigned = Object.keys(config.workers || {}).filter(workerId => !assigned.has(workerId))
  if (unassigned.length) throw new Error(`Every Worker must have exactly one role binding: ${unassigned.join(', ')}`)
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
