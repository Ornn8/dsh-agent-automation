// @ts-check
import { createHash } from 'node:crypto'
import { parseWorkerRouteDecision } from './worker-routing.mjs'
const FULL_SHA256 = /^[0-9a-f]{64}$/
const FULL_SHA1 = /^[0-9a-f]{40}$/
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/
const OBSERVATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/
const ROLES = new Set(['change', 'review'])
const SUBJECT_TYPES = new Set(['issue', 'pull-request'])
const PROJECTION_FIELDS = new Set([
  'version', 'workRequestId', 'repository', 'role', 'profileId', 'workflowId', 'stageId', 'definitionHash',
  'revision', 'coordinationKey', 'subject', 'routeDecision', 'capacityGenerationHash', 'observationId',
])
const SUBJECT_FIELDS = new Set(['type', 'number', 'stateVersion', 'base', 'head'])
const REVISION_FIELDS = new Set(['base', 'head'])
/** @typedef {Record<string, unknown>} AnyObject */
/** @param {unknown} value @returns {string} */
function text(value) {
  return typeof value === 'string' ? value : ''
}

/** @param {unknown} value @param {RegExp} pattern @param {string} field @returns {string} */
function identifier(value, pattern, field) {
  if (!pattern.test(text(value))) throw new Error(`CapacityWaitProjection ${field} is invalid`)
  return /** @type {string} */ (value)
}
/** @param {unknown} value @param {string} field @param {number} maximum @returns {string} */
function oneLineText(value, field, maximum = 300) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > maximum || /[\r\n]/.test(value)) {
    throw new Error(`CapacityWaitProjection ${field} is invalid`)
  }
  return value.trim()
}
/** @param {unknown} value @param {string} field @returns {number} */
function positiveNumber(value, field) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`CapacityWaitProjection ${field} is invalid`)
  }
  return /** @type {number} */ (value)
}
/** @param {unknown} value @returns {string} */
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    const object = /** @type {Record<string, unknown>} */ (value)
    return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}
/** @param {unknown} value @returns {AnyObject} */
function parseSubject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('CapacityWaitProjection subject is invalid')
  }
  const subject = /** @type {AnyObject} */ (value)
  for (const key of Object.keys(subject)) {
    if (!SUBJECT_FIELDS.has(key)) throw new Error(`CapacityWaitProjection subject has unknown field ${key}`)
  }
  const type = text(subject.type)
  if (!SUBJECT_TYPES.has(type)) throw new Error('CapacityWaitProjection subject.type is invalid')
  const output = {
    type,
    number: positiveNumber(subject.number, 'subject.number'),
    stateVersion: identifier(subject.stateVersion, FULL_SHA256, 'subject.stateVersion'),
  }
  if (type === 'pull-request') {
    return {
      ...output,
      base: identifier(subject.base, FULL_SHA1, 'subject.base'),
      head: identifier(subject.head, FULL_SHA1, 'subject.head'),
    }
  }
  if (Object.hasOwn(subject, 'base') || Object.hasOwn(subject, 'head')) {
    throw new Error('CapacityWaitProjection Issue subject cannot contain a pull-request pair')
  }
  return output
}
/** @param {unknown} value @returns {AnyObject} */
function parseRevision(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('CapacityWaitProjection revision is invalid')
  }
  const revision = /** @type {AnyObject} */ (value)
  for (const key of Object.keys(revision)) {
    if (!REVISION_FIELDS.has(key)) throw new Error(`CapacityWaitProjection revision has unknown field ${key}`)
  }
  return {
    base: identifier(revision.base, FULL_SHA1, 'revision.base'),
    head: identifier(revision.head, FULL_SHA1, 'revision.head'),
  }
}
/** @param {unknown} value @returns {AnyObject} */
function parseRouteDecision(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('CapacityWaitProjection routeDecision is invalid')
  }
  try {
    return parseWorkerRouteDecision(value)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`CapacityWaitProjection routeDecision is invalid: ${detail}`, { cause: error })
  }
}
/** Parse and validate one strict CapacityWaitProjection v1. @param {unknown} value @returns {AnyObject} */
export function parseCapacityWaitProjection(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('CapacityWaitProjection must be an object')
  }
  const projection = /** @type {AnyObject} */ (value)
  for (const key of Object.keys(projection)) {
    if (!PROJECTION_FIELDS.has(key)) throw new Error(`CapacityWaitProjection has unknown field ${key}`)
  }
  for (const key of PROJECTION_FIELDS) {
    if (!Object.hasOwn(projection, key)) throw new Error(`CapacityWaitProjection is missing ${key}`)
  }
  if (projection.version !== 1) throw new Error('CapacityWaitProjection version must be 1')
  const workRequestId = identifier(projection.workRequestId, REQUEST_ID, 'workRequestId')
  const repository = oneLineText(projection.repository, 'repository', 200)
  if (!REPOSITORY.test(repository)) throw new Error('CapacityWaitProjection repository is invalid')
  const role = text(projection.role)
  if (!ROLES.has(role)) throw new Error('CapacityWaitProjection role is invalid')
  const revision = parseRevision(projection.revision)
  const coordinationKey = oneLineText(projection.coordinationKey, 'coordinationKey')
  const subject = parseSubject(projection.subject)
  const routeDecision = parseRouteDecision(projection.routeDecision)
  if (routeDecision.workRequestId !== workRequestId || routeDecision.role !== role) {
    throw new Error('CapacityWaitProjection routeDecision does not match the WorkRequest')
  }
  if (routeDecision.stateVersion !== subject.stateVersion) {
    throw new Error('CapacityWaitProjection routeDecision does not match the subject')
  }
  if (subject.type === 'pull-request'
    && (revision.base !== subject.base || revision.head !== subject.head)) {
    throw new Error('CapacityWaitProjection revision does not match the pull request subject')
  }
  return {
    version: 1,
    workRequestId,
    repository,
    role,
    profileId: identifier(projection.profileId, IDENTIFIER, 'profileId'),
    workflowId: identifier(projection.workflowId, IDENTIFIER, 'workflowId'),
    stageId: identifier(projection.stageId, IDENTIFIER, 'stageId'),
    definitionHash: identifier(projection.definitionHash, FULL_SHA256, 'definitionHash'),
    revision,
    coordinationKey,
    subject,
    routeDecision,
    capacityGenerationHash: identifier(projection.capacityGenerationHash, FULL_SHA256, 'capacityGenerationHash'),
    observationId: identifier(projection.observationId, OBSERVATION_ID, 'observationId'),
  }
}
/** Create a strict CapacityWaitProjection v1. @param {AnyObject} value @returns {AnyObject} */
export function createCapacityWaitProjection(value = {}) {
  return parseCapacityWaitProjection({ version: 1, ...value })
}
/**
 * Return the stable identity for one complete capacity resume projection.
 * @param {AnyObject} value
 * @returns {string}
 */
export function capacityResumeRequestId(value = {}) {
  const projection = parseCapacityWaitProjection(value)
  const identity = {
    projection,
    subject: projection.subject,
    capacityGenerationHash: projection.capacityGenerationHash,
    routeDecision: projection.routeDecision,
  }
  return `capacity-resume-${createHash('sha256').update(canonicalJson(identity)).digest('hex')}`
}
/** Render a stable, sanitized status line containing one projection. @param {unknown} value @returns {string} */
export function capacityWaitStatusLine(value) {
  return `- Capacity wait: \`${canonicalJson(parseCapacityWaitProjection(value))}\``
}
/** Parse exactly one CapacityWaitProjection status line from a controller comment. @param {unknown} body @returns {AnyObject} */
export function parseCapacityWaitStatus(body) {
  const lines = [...String(body || '').matchAll(/^- Capacity wait: `([^`\r\n]+)`$/gm)]
  if (lines.length !== 1) throw new Error('CapacityWaitProjection status must contain exactly one projection')
  let value
  try {
    value = JSON.parse(lines[0][1])
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`CapacityWaitProjection status JSON is invalid: ${detail}`, { cause: error })
  }
  return parseCapacityWaitProjection(value)
}
