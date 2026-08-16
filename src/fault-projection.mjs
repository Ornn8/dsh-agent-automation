import { faultIdentity } from './fault-record.mjs'

const MARKER = '<!-- agent-infrastructure-fault:v1:'

function exactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === [...keys].sort().join(',')
}

/** Render a non-authorizing English GitHub Issue projection of one root fault observation. */
export function faultProjectionBody(value) {
  const faultId = faultIdentity(value)
  const payload = {
    version: 1,
    faultId,
    repository: value.repository,
    component: value.component,
    operation: value.operation,
    failureClass: value.failureClass,
    errorCode: value.errorCode,
    failureSignature: value.failureSignature,
    rootRequestIds: [...new Set(value.rootRequestIds)].sort(),
    sourceRunId: value.sourceRunId,
    projectionRunId: value.projectionRunId,
    controllerRepository: value.controllerRepository,
    controllerSha: value.controllerSha,
  }
  return [
    `${MARKER}${faultId} -->`,
    '## Infrastructure fault',
    '',
    'This Issue is an observable projection. Only the pinned recovery workflow and its Actions provenance authorize maintenance.',
    '',
    '<details>',
    '<summary>Fault observation</summary>',
    '',
    '```json',
    JSON.stringify(payload),
    '```',
    '</details>',
  ].join('\n')
}

/** Parse one strict root fault projection without treating it as authorization. */
export function parseFaultProjection(body) {
  const text = String(body || '')
  const marker = new RegExp(`^${MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([0-9a-f]{64}) -->$`, 'm').exec(text)
  const block = /<summary>Fault observation<\/summary>\s*```json\s*([^\r\n]+)\s*```/m.exec(text)
  if (!marker || !block) throw new Error('Infrastructure fault projection is incomplete')
  let value
  try { value = JSON.parse(block[1]) } catch (error) { throw new Error(`Infrastructure fault projection is invalid JSON: ${error.message}`) }
  const keys = ['version', 'faultId', 'repository', 'component', 'operation', 'failureClass', 'errorCode', 'failureSignature', 'rootRequestIds', 'sourceRunId', 'projectionRunId', 'controllerRepository', 'controllerSha']
  if (!exactKeys(value, keys) || value.version !== 1 || value.faultId !== marker[1]
    || !Number.isSafeInteger(value.sourceRunId) || value.sourceRunId < 1
    || !Number.isSafeInteger(value.projectionRunId) || value.projectionRunId < 1
    || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value.controllerRepository || '')
    || !/^[0-9a-f]{40}$/.test(value.controllerSha || '')
    || !/^workflow:[0-9a-f]{64}$/.test(value.failureSignature || '')
    || !Array.isArray(value.rootRequestIds) || value.rootRequestIds.length < 1
    || faultIdentity(value) !== value.faultId) {
    throw new Error('Infrastructure fault projection fields are invalid')
  }
  return value
}

/** Return the exact marker used to deduplicate one root fault Issue. */
export function faultProjectionMarker(faultId) {
  if (!/^[0-9a-f]{64}$/.test(faultId || '')) throw new Error('faultId is invalid')
  return `${MARKER}${faultId} -->`
}
