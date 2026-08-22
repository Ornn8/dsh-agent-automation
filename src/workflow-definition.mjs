import { createHash } from 'node:crypto'

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const STAGE_USES = new Set(['worker', 'checks', 'merge'])
const WORKER_ROLES = new Set(['change', 'review'])
const MERGE_MODES = new Set(['auto', 'manual'])
const MERGE_STRATEGIES = new Set(['merge', 'squash', 'rebase'])
const MAX_WORKFLOWS = 32
const MAX_STAGES = 64
const MAX_RETRIES = 10
const MAX_BACKOFF_SECONDS = 86_400
const CONTRACT_PATH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0
}

function requireObject(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${name} must be an object`)
  }
  return value
}

function requireFields(value, required, allowed, name) {
  const object = requireObject(value, name)
  for (const key of Object.keys(object)) {
    if (!allowed.has(key)) throw new Error(`${name} has unknown field ${key}`)
  }
  for (const key of required) {
    if (!Object.hasOwn(object, key)) throw new Error(`${name} is missing required field ${key}`)
  }
  return object
}

function identifier(value, name) {
  if (typeof value !== 'string' || !ID.test(value)) {
    throw new Error(`${name} must be an identifier of at most 64 characters`)
  }
  return value
}

function boundedText(value, name, maximum) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > maximum || /[\r\n]/.test(value)) {
    throw new Error(`${name} must be non-empty one-line text of at most ${maximum} characters`)
  }
  return value.trim()
}

function verificationContractLocator(value) {
  const object = requireFields(
    value,
    ['path'],
    new Set(['path']),
    'Workflow Definition verificationContract',
  )
  const path = object.path
  if (typeof path !== 'string' || !CONTRACT_PATH.test(path)
    || path.split('/').some(part => part === '.' || part === '..')) {
    throw new Error('Workflow Definition verificationContract.path must be a safe relative path')
  }
  return { path }
}

function uniqueIdentifiers(value, name) {
  if (!Array.isArray(value) || value.length > MAX_STAGES) {
    throw new Error(`${name} must be an array of at most ${MAX_STAGES} Stage ids`)
  }
  const result = value.map((item, index) => identifier(item, `${name}[${index}]`))
  if (new Set(result).size !== result.length) throw new Error(`${name} must not contain duplicate Stage ids`)
  return result.sort()
}

function retryDefinition(value, name) {
  const object = requireFields(
    value,
    ['limit', 'backoffSeconds'],
    new Set(['limit', 'backoffSeconds']),
    name,
  )
  if (!Number.isSafeInteger(object.limit) || object.limit < 1 || object.limit > MAX_RETRIES) {
    throw new Error(`${name}.limit must be from 1 to ${MAX_RETRIES}`)
  }
  if (!Array.isArray(object.backoffSeconds) || object.backoffSeconds.length !== object.limit
    || object.backoffSeconds.some(seconds => !Number.isSafeInteger(seconds)
      || seconds < 1 || seconds > MAX_BACKOFF_SECONDS)) {
    throw new Error(`${name}.backoffSeconds must contain one value from 1 to ${MAX_BACKOFF_SECONDS} for each retry`)
  }
  return { limit: object.limit, backoffSeconds: [...object.backoffSeconds] }
}

function commonStage(value, workflowId, index) {
  const name = `workflow ${workflowId} Stage ${index}`
  const object = requireObject(value, name)
  const id = identifier(object.id, `${name}.id`)
  const uses = boundedText(object.uses, `${name}.uses`, 32)
  if (!STAGE_USES.has(uses)) throw new Error(`${name}.uses is unsupported: ${uses}`)
  return {
    name: `workflow ${workflowId} Stage ${id}`,
    object,
    common: {
      id,
      uses,
      after: uniqueIdentifiers(object.after, `${name}.after`),
      ...(Object.hasOwn(object, 'retry') ? { retry: retryDefinition(object.retry, `${name}.retry`) } : {}),
    },
  }
}

function workerStage(common, object, name) {
  requireFields(
    object,
    ['id', 'uses', 'after', 'role', 'procedure'],
    new Set(['id', 'uses', 'after', 'retry', 'role', 'procedure']),
    name,
  )
  const role = identifier(object.role, `${name}.role`)
  if (!WORKER_ROLES.has(role)) throw new Error(`${name}.role must be change or review`)
  return {
    ...common,
    role,
    procedure: boundedText(object.procedure, `${name}.procedure`, 128),
  }
}

function checksStage(common, object, name) {
  requireFields(
    object,
    ['id', 'uses', 'after'],
    new Set(['id', 'uses', 'after', 'retry', 'names', 'source']),
    name,
  )
  const hasNames = Object.hasOwn(object, 'names')
  const hasSource = Object.hasOwn(object, 'source')
  if (hasNames === hasSource) {
    throw new Error(`${name} must declare exactly one of names or source`)
  }
  if (hasSource) {
    if (object.source !== 'branch-protection') {
      throw new Error(`${name}.source must be branch-protection`)
    }
    return { ...common, source: object.source }
  }
  if (!Array.isArray(object.names) || object.names.length < 1 || object.names.length > 32) {
    throw new Error(`${name}.names must contain from 1 to 32 check names`)
  }
  const names = object.names.map((checkName, index) => boundedText(checkName, `${name}.names[${index}]`, 128))
  if (new Set(names).size !== names.length) throw new Error(`${name}.names must not contain duplicate check names`)
  return { ...common, names: names.sort() }
}

function mergeStage(common, object, name) {
  requireFields(
    object,
    ['id', 'uses', 'after', 'mode', 'strategy', 'deleteBranch'],
    new Set(['id', 'uses', 'after', 'retry', 'mode', 'strategy', 'deleteBranch']),
    name,
  )
  if (!MERGE_MODES.has(object.mode)) throw new Error(`${name}.mode must be auto or manual`)
  if (!MERGE_STRATEGIES.has(object.strategy)) throw new Error(`${name}.strategy is unsupported`)
  if (typeof object.deleteBranch !== 'boolean') throw new Error(`${name}.deleteBranch must be boolean`)
  return {
    ...common,
    mode: object.mode,
    strategy: object.strategy,
    deleteBranch: object.deleteBranch,
  }
}

function stageDefinition(value, workflowId, index) {
  const { common, object, name } = commonStage(value, workflowId, index)
  if (common.uses === 'worker') return workerStage(common, object, name)
  if (common.uses === 'checks') return checksStage(common, object, name)
  return mergeStage(common, object, name)
}

function validateGraph(stages, workflowId) {
  const ids = new Set(stages.map(stage => stage.id))
  if (ids.size !== stages.length) throw new Error(`workflow ${workflowId} Stage ids must be unique`)
  for (const stage of stages) {
    for (const dependency of stage.after) {
      if (!ids.has(dependency)) {
        throw new Error(`workflow ${workflowId} Stage ${stage.id} references unknown Stage ${dependency}`)
      }
      if (dependency === stage.id) {
        throw new Error(`workflow ${workflowId} Stage ${stage.id} cannot depend on itself`)
      }
    }
  }

  const visited = new Set()
  const active = new Set()
  const byId = new Map(stages.map(stage => [stage.id, stage]))
  const visit = (id) => {
    if (active.has(id)) throw new Error(`workflow ${workflowId} Stage graph must be acyclic`)
    if (visited.has(id)) return
    active.add(id)
    for (const dependency of byId.get(id).after) visit(dependency)
    active.delete(id)
    visited.add(id)
  }
  for (const id of ids) visit(id)
}

function workflowDefinition(value, workflowId) {
  const name = `workflow ${workflowId}`
  const object = requireFields(
    value,
    ['stages', 'coordination'],
    new Set(['description', 'stages', 'coordination']),
    name,
  )
  if (!Array.isArray(object.stages) || object.stages.length < 1 || object.stages.length > MAX_STAGES) {
    throw new Error(`${name}.stages must contain from 1 to ${MAX_STAGES} Stages`)
  }
  const stages = object.stages.map((stage, index) => stageDefinition(stage, workflowId, index))
  validateGraph(stages, workflowId)

  const coordination = requireFields(
    object.coordination,
    ['limit'],
    new Set(['limit']),
    `${name}.coordination`,
  )
  if (!Number.isSafeInteger(coordination.limit) || coordination.limit < 1 || coordination.limit > 100) {
    throw new Error(`${name}.coordination.limit must be from 1 to 100`)
  }
  return {
    ...(Object.hasOwn(object, 'description')
      ? { description: boundedText(object.description, `${name}.description`, 500) }
      : {}),
    stages: stages.sort((left, right) => compareText(left.id, right.id)),
    coordination: { limit: coordination.limit },
  }
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

/** Validate and normalize one trusted Workflow Definition document. */
export function parseWorkflowDefinition(value) {
  const object = requireFields(
    value,
    ['version', 'profileId', 'workflows'],
    new Set(['version', 'profileId', 'workflows', 'verificationContract']),
    'Workflow Definition',
  )
  if (object.version !== 1) throw new Error('Workflow Definition version must be 1')
  const profileId = identifier(object.profileId, 'Workflow Definition profileId')
  const workflows = requireObject(object.workflows, 'Workflow Definition workflows')
  const entries = Object.entries(workflows)
  if (entries.length < 1 || entries.length > MAX_WORKFLOWS) {
    throw new Error(`Workflow Definition workflows must contain from 1 to ${MAX_WORKFLOWS} workflows`)
  }

  const normalized = entries.map(([rawId, workflow]) => {
    const id = identifier(rawId, 'Workflow Definition workflow id')
    return [id, workflowDefinition(workflow, id)]
  }).sort(([left], [right]) => compareText(left, right))
  return {
    version: 1,
    profileId,
    ...(Object.hasOwn(object, 'verificationContract')
      ? { verificationContract: verificationContractLocator(object.verificationContract) }
      : {}),
    workflows: Object.fromEntries(normalized),
  }
}

/** Return the stable SHA-256 identity of one normalized Workflow Definition. */
export function workflowDefinitionHash(value) {
  const definition = parseWorkflowDefinition(value)
  return createHash('sha256').update(canonicalJson(definition)).digest('hex')
}
