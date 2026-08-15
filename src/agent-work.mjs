import { createHash } from 'node:crypto'
import { validateIssueBranch } from './common.mjs'

const MARKER = '<!-- agent-work:v1 -->'
const REQUIRED_FIELDS = ['version', 'dispatch', 'role', 'kind', 'dependsOn']
const ALLOWED_FIELDS = new Set([...REQUIRED_FIELDS, 'branch'])
const KINDS = new Set(['implementation', 'bug-fix', 'integration', 'documentation'])

function validateDependencies(value) {
  if (!Array.isArray(value)
    || value.length > 100
    || value.some(number => !Number.isSafeInteger(number) || number < 1)
    || new Set(value).size !== value.length) {
    throw new Error('agent-work:v1 dependsOn must contain unique positive Issue numbers')
  }
  return value
}

/** Parse the machine-readable agent work declaration from an Issue body. */
export function parseAgentWork(body) {
  const source = String(body || '')
  const markers = source.split(MARKER).length - 1
  if (markers === 0) return null
  if (markers !== 1) throw new Error('An Issue must contain exactly one agent-work:v1 declaration')

  const markerAt = source.indexOf(MARKER)
  const fenced = source.slice(markerAt + MARKER.length)
    .match(/^\s*```json\s*\r?\n([\s\S]*?)\r?\n```/)
  if (!fenced) throw new Error('agent-work:v1 must be followed by one JSON code block')
  if (fenced[1].length > 4096) throw new Error('agent-work:v1 JSON exceeds 4096 characters')

  let value
  try {
    value = JSON.parse(fenced[1])
  } catch {
    throw new Error('agent-work:v1 must contain valid JSON')
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('agent-work:v1 JSON must be an object')
  }
  for (const key of Object.keys(value)) {
    if (!ALLOWED_FIELDS.has(key)) throw new Error(`agent-work:v1 has unknown field ${key}`)
  }
  for (const key of REQUIRED_FIELDS) {
    if (!Object.hasOwn(value, key)) throw new Error(`agent-work:v1 is missing required field ${key}`)
  }
  if (value.version !== 1) throw new Error('agent-work:v1 version must be 1')
  if (!['ready', 'hold'].includes(value.dispatch)) throw new Error('agent-work:v1 dispatch must be ready or hold')
  if (value.role !== 'change') throw new Error('agent-work:v1 role must be change')
  if (!KINDS.has(value.kind)) throw new Error('agent-work:v1 kind is unsupported')

  const result = {
    version: value.version,
    dispatch: value.dispatch,
    role: value.role,
    kind: value.kind,
    ...(Object.hasOwn(value, 'branch') ? { branch: validateIssueBranch(value.branch) } : {}),
    dependsOn: validateDependencies(value.dependsOn),
  }
  return result
}

/** Return the stable dispatch identity for one validated agent-work declaration. */
export function agentWorkRequestId(work) {
  const digest = createHash('sha256').update(JSON.stringify(work)).digest('hex').slice(0, 32)
  return `agent-work-${digest}`
}

/** Resolve the work branch for one ready agent-work declaration. */
export function agentWorkBranch(work, issueNumber) {
  if (work?.dispatch !== 'ready') throw new Error('agent-work:v1 is not ready for dispatch')
  if (!Number.isSafeInteger(issueNumber) || issueNumber < 1) throw new Error('Issue number must be positive')
  return work.branch || `agent/issue-${issueNumber}`
}

/** Bind a queued request id to the current live agent-work declaration. */
export function resolveAgentWorkDispatch(body, issueNumber, requestId) {
  const work = parseAgentWork(body)
  if (String(requestId || '').startsWith('agent-work-')) {
    if (!work || requestId !== agentWorkRequestId(work)) {
      throw new Error(`Issue #${issueNumber} agent-work:v1 changed after dispatch`)
    }
  }
  return work ? { work, branch: agentWorkBranch(work, issueNumber) } : null
}
