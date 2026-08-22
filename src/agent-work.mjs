import { createHash } from 'node:crypto'
import { validateIssueBranch } from './common.mjs'
import { DEFAULT_PROFILE_ID } from './workflow-profile.mjs'

const MARKER = '<!-- agent-work:v2 -->'
const REQUIRED_FIELDS = ['version', 'dispatch', 'workflow', 'dependsOn']
const ALLOWED_FIELDS = new Set([...REQUIRED_FIELDS, 'profile', 'branch'])
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const DEFINITION_HASH = /^[0-9a-f]{64}$/
const CONTRACT_HASH = /^[0-9a-f]{64}$/

function validateDependencies(value) {
  if (!Array.isArray(value)
    || value.length > 100
    || value.some(number => !Number.isSafeInteger(number) || number < 1)
    || new Set(value).size !== value.length) {
    throw new Error('agent-work:v2 dependsOn must contain unique positive Issue numbers')
  }
  return value
}

function identifier(value, name) {
  if (typeof value !== 'string' || !ID.test(value)) {
    throw new Error(`agent-work:v2 ${name} must be an identifier of at most 64 characters`)
  }
  return value
}

/** Parse the machine-readable orchestration declaration from an Issue body. */
export function parseAgentWork(body) {
  const source = String(body || '')
  const markers = source.split(MARKER).length - 1
  if (markers === 0) return null
  if (markers !== 1) throw new Error('An Issue must contain exactly one agent-work:v2 declaration')

  const markerAt = source.indexOf(MARKER)
  const fenced = source.slice(markerAt + MARKER.length)
    .match(/^\s*```json\s*\r?\n([\s\S]*?)\r?\n```/)
  if (!fenced) throw new Error('agent-work:v2 must be followed by one JSON code block')
  if (fenced[1].length > 4096) throw new Error('agent-work:v2 JSON exceeds 4096 characters')

  let value
  try {
    value = JSON.parse(fenced[1])
  } catch {
    throw new Error('agent-work:v2 must contain valid JSON')
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('agent-work:v2 JSON must be an object')
  }
  for (const key of Object.keys(value)) {
    if (!ALLOWED_FIELDS.has(key)) throw new Error(`agent-work:v2 has unknown field ${key}`)
  }
  for (const key of REQUIRED_FIELDS) {
    if (!Object.hasOwn(value, key)) throw new Error(`agent-work:v2 is missing required field ${key}`)
  }
  if (value.version !== 2) throw new Error('agent-work:v2 version must be 2')
  if (!['ready', 'hold'].includes(value.dispatch)) throw new Error('agent-work:v2 dispatch must be ready or hold')

  return {
    version: 2,
    dispatch: value.dispatch,
    profile: Object.hasOwn(value, 'profile')
      ? identifier(value.profile, 'profile')
      : DEFAULT_PROFILE_ID,
    workflow: identifier(value.workflow, 'workflow'),
    ...(Object.hasOwn(value, 'branch') ? { branch: validateIssueBranch(value.branch) } : {}),
    dependsOn: validateDependencies(value.dependsOn),
  }
}

/** Return the stable dispatch identity bound to the exact trusted Profile definition. */
export function agentWorkRequestId(work, definitionHash, verificationContractHash) {
  if (!DEFINITION_HASH.test(definitionHash || '')) {
    throw new Error('agent-work:v2 request identity requires a Workflow Definition hash')
  }
  if (verificationContractHash !== undefined && !CONTRACT_HASH.test(verificationContractHash || '')) {
    throw new Error('agent-work:v2 request identity requires a Verification Contract hash')
  }
  const digest = createHash('sha256')
    .update(JSON.stringify({
      work,
      definitionHash,
      ...(verificationContractHash === undefined ? {} : { verificationContractHash }),
    }))
    .digest('hex')
    .slice(0, 32)
  return `agent-work-${digest}`
}

/** Resolve the work branch for one ready orchestration declaration. */
export function agentWorkBranch(work, issueNumber) {
  if (work?.dispatch !== 'ready') throw new Error('agent-work:v2 is not ready for dispatch')
  if (!Number.isSafeInteger(issueNumber) || issueNumber < 1) throw new Error('Issue number must be positive')
  return work.branch || `agent/issue-${issueNumber}`
}

/** Bind a queued request id to the current live declaration and trusted Profile hash. */
export function resolveAgentWorkDispatch(body, issueNumber, requestId, definitionHash, verificationContractHash) {
  const work = parseAgentWork(body)
  if (String(requestId || '').startsWith('agent-work-')) {
    if (!work || requestId !== agentWorkRequestId(work, definitionHash, verificationContractHash)) {
      throw new Error(`Issue #${issueNumber} agent-work:v2 or its Profile changed after dispatch`)
    }
  }
  return work ? { work, branch: agentWorkBranch(work, issueNumber) } : null
}

/** Return dependencies that are still open after rereading their live Issue state. */
export async function openAgentWorkDependencies(work, readIssue) {
  const issues = await Promise.all(work.dependsOn.map(number => readIssue(number)))
  return issues.map((issue, index) => {
    const expectedNumber = work.dependsOn[index]
    if (issue?.number !== expectedNumber || issue.pull_request
      || !['open', 'closed'].includes(issue.state)) {
      throw new Error(`agent-work:v2 dependency #${expectedNumber} must reference an Issue`)
    }
    return issue
  }).filter(issue => issue.state === 'open').map(issue => issue.number)
}
