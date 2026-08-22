import { createHash } from 'node:crypto'
import { validateIssueBranch } from './common.mjs'
import { DEFAULT_PROFILE_ID } from './workflow-profile.mjs'

const MARKERS = new Map([
  [2, '<!-- agent-work:v2 -->'],
  [3, '<!-- agent-work:v3 -->'],
])
const REQUIRED_FIELDS = ['version', 'dispatch', 'workflow', 'dependsOn']
const V3_REQUIRED_FIELDS = [...REQUIRED_FIELDS, 'parent', 'taskClass']
const V2_ALLOWED_FIELDS = new Set([...REQUIRED_FIELDS, 'profile', 'branch'])
const V3_ALLOWED_FIELDS = new Set([...V3_REQUIRED_FIELDS, 'profile', 'branch'])
const V3_PROSE_SECTIONS = ['Objective', 'Scope', 'Acceptance criteria']
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const DEFINITION_HASH = /^[0-9a-f]{64}$/
const CONTRACT_HASH = /^[0-9a-f]{64}$/

function positiveIssueNumber(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`agent-work:v3 ${name} must be a positive Issue number`)
  return value
}

function validateDependencies(value, issueNumber) {
  if (!Array.isArray(value)
    || value.length > 100
    || value.some(number => !Number.isSafeInteger(number) || number < 1)
    || new Set(value).size !== value.length) {
    throw new Error('agent-work declaration dependsOn must contain unique positive Issue numbers')
  }
  if (issueNumber !== undefined && value.includes(issueNumber)) {
    throw new Error(`agent-work:v3 dependsOn must not reference the executable Issue #${issueNumber}`)
  }
  return value
}

function identifier(value, name) {
  if (typeof value !== 'string' || !ID.test(value)) {
    throw new Error(`agent-work declaration ${name} must be an identifier of at most 64 characters`)
  }
  return value
}

function validateV3Prose(source) {
  for (const section of V3_PROSE_SECTIONS) {
    const heading = new RegExp(`^## ${section.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}[ \\t]*$`, 'gm')
    const matches = [...source.matchAll(heading)]
    if (matches.length !== 1) throw new Error(`agent-work:v3 prose must contain exactly one ## ${section} section`)
    const start = matches[0].index + matches[0][0].length
    const nextHeading = /^##[ \t]+.*$/gm
    nextHeading.lastIndex = start
    const next = nextHeading.exec(source)
    const content = source.slice(start, next ? next.index : source.length).trim()
    if (!content) throw new Error(`agent-work:v3 ## ${section} section must not be empty`)
  }
}

/** Parse the machine-readable orchestration declaration from an Issue body. */
export function parseAgentWork(body, options = {}) {
  const source = String(body || '')
  const markers = [...source.matchAll(/<!-- agent-work:v([23]) -->/g)]
  if (markers.length === 0) return null
  if (markers.length !== 1) throw new Error('An Issue must contain exactly one recognized agent-work declaration')
  const version = Number.parseInt(markers[0][1], 10)
  const marker = MARKERS.get(version)
  const label = `agent-work:v${version}`
  const issueNumber = options.issueNumber === undefined
    ? undefined
    : positiveIssueNumber(options.issueNumber, 'issueNumber')

  const markerAt = markers[0].index
  const fenced = source.slice(markerAt + marker.length)
    .match(/^\s*```json\s*\r?\n([\s\S]*?)\r?\n```/)
  if (!fenced) throw new Error(`${label} must be followed by one JSON code block`)
  if (fenced[1].length > 4096) throw new Error(`${label} JSON exceeds 4096 characters`)

  let value
  try {
    value = JSON.parse(fenced[1])
  } catch {
    throw new Error(`${label} must contain valid JSON`)
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} JSON must be an object`)
  }
  const allowedFields = version === 2 ? V2_ALLOWED_FIELDS : V3_ALLOWED_FIELDS
  const requiredFields = version === 2 ? REQUIRED_FIELDS : V3_REQUIRED_FIELDS
  for (const key of Object.keys(value)) {
    if (!allowedFields.has(key)) throw new Error(`${label} has unknown field ${key}`)
  }
  for (const key of requiredFields) {
    if (!Object.hasOwn(value, key)) throw new Error(`${label} is missing required field ${key}`)
  }
  if (value.version !== version) throw new Error(`${label} version must be ${version}`)
  if (!['ready', 'hold'].includes(value.dispatch)) throw new Error(`${label} dispatch must be ready or hold`)
  if (version === 3) validateV3Prose(source)

  const parent = version === 3 ? positiveIssueNumber(value.parent, 'parent') : undefined
  if (parent !== undefined && issueNumber !== undefined && parent === issueNumber) {
    throw new Error(`agent-work:v3 parent must not reference the executable Issue #${issueNumber}`)
  }
  const taskClass = version === 3 ? identifier(value.taskClass, 'taskClass') : 'default'

  return {
    version,
    dispatch: value.dispatch,
    profile: Object.hasOwn(value, 'profile')
      ? identifier(value.profile, 'profile')
      : DEFAULT_PROFILE_ID,
    workflow: identifier(value.workflow, 'workflow'),
    ...(Object.hasOwn(value, 'branch') ? { branch: validateIssueBranch(value.branch) } : {}),
    ...(parent === undefined ? {} : { parent }),
    taskClass,
    dependsOn: validateDependencies(value.dependsOn, version === 3 ? issueNumber : undefined),
  }
}

/** Return the stable dispatch identity bound to the exact trusted Profile definition. */
export function agentWorkRequestId(work, definitionHash, verificationContractHash) {
  if (!DEFINITION_HASH.test(definitionHash || '')) {
    throw new Error('agent-work request identity requires a Workflow Definition hash')
  }
  if (verificationContractHash !== undefined && !CONTRACT_HASH.test(verificationContractHash || '')) {
    throw new Error('agent-work request identity requires a Verification Contract hash')
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
  if (work?.dispatch !== 'ready') throw new Error('agent-work declaration is not ready for dispatch')
  if (!Number.isSafeInteger(issueNumber) || issueNumber < 1) throw new Error('Issue number must be positive')
  return work.branch || `agent/issue-${issueNumber}`
}

/** Bind a queued request id to the current live declaration and trusted Profile hash. */
export function resolveAgentWorkDispatch(body, issueNumber, requestId, definitionHash, verificationContractHash) {
  const work = parseAgentWork(body, { issueNumber })
  if (String(requestId || '').startsWith('agent-work-')) {
    if (!work || requestId !== agentWorkRequestId(work, definitionHash, verificationContractHash)) {
      throw new Error(`Issue #${issueNumber} agent-work declaration or its Profile changed after dispatch`)
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
      throw new Error(`agent-work dependency #${expectedNumber} must reference an Issue`)
    }
    return issue
  }).filter(issue => issue.state === 'open').map(issue => issue.number)
}
