import { createHash } from 'node:crypto'

const MARKER = 'agent-task:v1'
const MAX_BODY_BYTES = 64 * 1024
const MAX_DEPENDENCIES = 32
const MAX_ISSUE_NUMBER = 2_147_483_647
const REQUIRED_SECTIONS = ['Objective', 'Scope', 'Acceptance criteria']

function positiveIssueNumber(value, name = 'Issue number') {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_ISSUE_NUMBER) {
    throw new Error(`${name} must be a positive bounded integer`)
  }
  return value
}

function requireTaskSections(body) {
  const lines = body.split(/\r?\n/)
  for (const title of REQUIRED_SECTIONS) {
    const heading = `## ${title}`.toLowerCase()
    const start = lines.findIndex(line => line.trim().toLowerCase() === heading)
    if (start < 0) throw new Error(`Task is missing the ${title} section`)

    let hasContent = false
    for (let index = start + 1; index < lines.length; index += 1) {
      const line = lines[index].trim()
      if (/^##\s+/.test(line) || /<!--\s*agent-task:v1\s*-->/.test(line)) break
      if (line) hasContent = true
    }
    if (!hasContent) throw new Error(`Task has an empty ${title} section`)
  }
}

function normalizeTask(value, issueNumber) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Task declaration must be a JSON object')
  }
  const fields = Object.keys(value).sort()
  const expected = ['dependsOn', 'dispatch', 'version']
  if (fields.length !== expected.length || fields.some((field, index) => field !== expected[index])) {
    throw new Error('Task declaration has missing or unknown fields')
  }
  if (value.version !== 1) throw new Error('Task declaration version must be 1')
  if (!['ready', 'hold'].includes(value.dispatch)) {
    throw new Error('Task dispatch must be ready or hold')
  }
  if (!Array.isArray(value.dependsOn) || value.dependsOn.length > MAX_DEPENDENCIES) {
    throw new Error('Task dependencies must be a bounded array')
  }

  const dependencies = value.dependsOn.map(number => positiveIssueNumber(number, 'Dependency'))
  if (new Set(dependencies).size !== dependencies.length) {
    throw new Error('Task dependencies must be unique')
  }
  if (issueNumber !== undefined && dependencies.includes(issueNumber)) {
    throw new Error('Task cannot depend on itself')
  }

  return {
    version: 1,
    dispatch: value.dispatch,
    dependsOn: dependencies.sort((left, right) => left - right),
  }
}

export function parseTaskDeclaration(body, { issueNumber } = {}) {
  if (typeof body !== 'string') throw new Error('Issue body must be a string')
  if (Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES) throw new Error('Issue body is too large')
  if (issueNumber !== undefined) positiveIssueNumber(issueNumber)

  const markers = body.match(/<!--\s*agent-task:v1\s*-->/g) || []
  if (markers.length === 0) return null
  if (markers.length !== 1) throw new Error('Issue must contain exactly one task declaration')
  if (/<!--\s*agent-work:v[0-9]+\s*-->/.test(body)) {
    throw new Error('Issue cannot mix legacy and V2 task declarations')
  }

  const match = body.match(/<!--\s*agent-task:v1\s*-->\s*```json\s*([\s\S]*?)\s*```/)
  if (!match) throw new Error('Task declaration must be followed by one JSON code block')
  requireTaskSections(body)

  let value
  try {
    value = JSON.parse(match[1])
  } catch {
    throw new Error('Task declaration contains invalid JSON')
  }
  return normalizeTask(value, issueNumber)
}

export function taskIdentity({ repository, issueNumber, task }) {
  if (typeof repository !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new Error('Repository must use owner/name form')
  }
  positiveIssueNumber(issueNumber)
  const normalizedTask = normalizeTask(task, issueNumber)
  const canonical = JSON.stringify({
    protocol: MARKER,
    repository: repository.toLowerCase(),
    issueNumber,
    task: normalizedTask,
  })
  return `task-${createHash('sha256').update(canonical).digest('hex')}`
}

export function decideTaskEligibility({
  repository,
  issue,
  trustedAuthor = false,
  dependencies = [],
  activeTaskIds = [],
  hasOpenPullRequest = false,
} = {}) {
  if (!issue || issue.state !== 'open') return { status: 'terminal', reason: 'issue-not-open' }
  if (!trustedAuthor) return { status: 'invalid', reason: 'untrusted-author' }

  let task
  try {
    task = parseTaskDeclaration(issue.body, { issueNumber: issue.number })
  } catch (error) {
    return { status: 'invalid', reason: 'invalid-declaration', detail: error.message }
  }
  if (!task) return { status: 'ineligible', reason: 'missing-declaration' }

  const taskId = taskIdentity({ repository, issueNumber: issue.number, task })
  if (task.dispatch === 'hold') return { status: 'hold', reason: 'dispatch-hold', taskId, task }
  if (hasOpenPullRequest) return { status: 'active', reason: 'open-pull-request', taskId, task }
  if (activeTaskIds.includes(taskId)) return { status: 'active', reason: 'claimed', taskId, task }

  const byNumber = new Map()
  const conflictingDependencies = new Set()
  for (const dependency of dependencies) {
    if (!Number.isSafeInteger(dependency?.number)) continue
    const normalized = { number: dependency.number, state: dependency.state, type: dependency.type }
    const previous = byNumber.get(normalized.number)
    if (!previous) byNumber.set(normalized.number, normalized)
    else if (previous.state !== normalized.state || previous.type !== normalized.type) {
      conflictingDependencies.add(normalized.number)
    }
  }

  const waiting = []
  for (const number of task.dependsOn) {
    if (conflictingDependencies.has(number)) {
      return { status: 'invalid', reason: 'dependency-conflict', dependency: number, taskId, task }
    }
    const dependency = byNumber.get(number)
    if (!dependency) return { status: 'invalid', reason: 'dependency-missing', dependency: number, taskId, task }
    if (dependency.type !== 'issue') {
      return { status: 'invalid', reason: 'dependency-not-issue', dependency: number, taskId, task }
    }
    if (dependency.state === 'open') waiting.push(number)
    else if (dependency.state !== 'closed') {
      return { status: 'invalid', reason: 'dependency-invalid-state', dependency: number, taskId, task }
    }
  }

  if (waiting.length > 0) return { status: 'waiting', reason: 'open-dependencies', dependencies: waiting, taskId, task }
  return { status: 'ready', reason: 'eligible', taskId, task }
}
