// @ts-check

import { createHash } from 'node:crypto'

const MARKER = 'agent-task:v1'
const MAX_BODY_BYTES = 64 * 1024
const MAX_DEPENDENCIES = 32
const MAX_ISSUE_NUMBER = 2_147_483_647
const REQUIRED_SECTIONS = ['Objective', 'Scope', 'Acceptance criteria']

/**
 * @typedef {{
 *   version: 1,
 *   dispatch: 'ready' | 'hold',
 *   dependsOn: number[],
 * }} TaskDeclaration
 */

/**
 * @typedef {{
 *   number: number,
 *   state: unknown,
 *   type: unknown,
 * }} NormalizedDependencyObservation
 */

/**
 * @typedef {{
 *   repository?: unknown,
 *   issue?: unknown,
 *   trustedAuthor?: boolean,
 *   dependencies?: unknown[],
 *   activeTaskIds?: unknown[],
 *   hasOpenPullRequest?: boolean,
 * }} TaskEligibilityInput
 */

/**
 * @param {unknown} value
 * @param {string} [name]
 * @returns {number}
 */
function positiveIssueNumber(value, name = 'Issue number') {
  if (!Number.isSafeInteger(value) || /** @type {number} */ (value) < 1 || /** @type {number} */ (value) > MAX_ISSUE_NUMBER) {
    throw new Error(`${name} must be a positive bounded integer`)
  }
  return /** @type {number} */ (value)
}

/**
 * @param {string} body
 * @returns {void}
 */
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

/**
 * @param {unknown} value
 * @param {unknown} [issueNumber]
 * @returns {TaskDeclaration}
 */
function normalizeTask(value, issueNumber) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Task declaration must be a JSON object')
  }
  const task = /** @type {Record<string, unknown>} */ (value)
  const fields = Object.keys(task).sort()
  const expected = ['dependsOn', 'dispatch', 'version']
  if (fields.length !== expected.length || fields.some((field, index) => field !== expected[index])) {
    throw new Error('Task declaration has missing or unknown fields')
  }
  if (task.version !== 1) throw new Error('Task declaration version must be 1')
  if (task.dispatch !== 'ready' && task.dispatch !== 'hold') {
    throw new Error('Task dispatch must be ready or hold')
  }
  if (!Array.isArray(task.dependsOn) || task.dependsOn.length > MAX_DEPENDENCIES) {
    throw new Error('Task dependencies must be a bounded array')
  }

  const dependencies = task.dependsOn.map(number => positiveIssueNumber(number, 'Dependency'))
  if (new Set(dependencies).size !== dependencies.length) {
    throw new Error('Task dependencies must be unique')
  }
  const normalizedIssueNumber = issueNumber === undefined ? undefined : positiveIssueNumber(issueNumber)
  if (normalizedIssueNumber !== undefined && dependencies.includes(normalizedIssueNumber)) {
    throw new Error('Task cannot depend on itself')
  }

  return {
    version: 1,
    dispatch: task.dispatch,
    dependsOn: dependencies.sort((left, right) => left - right),
  }
}

/**
 * @param {unknown} body
 * @param {{ issueNumber?: unknown }} [options]
 * @returns {TaskDeclaration | null}
 */
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

  /** @type {unknown} */
  let value
  try {
    value = JSON.parse(match[1])
  } catch {
    throw new Error('Task declaration contains invalid JSON')
  }
  return normalizeTask(value, issueNumber)
}

/**
 * @param {{ repository?: unknown, issueNumber?: unknown, task?: unknown }} input
 * @returns {string}
 */
export function taskIdentity({ repository, issueNumber, task }) {
  if (typeof repository !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new Error('Repository must use owner/name form')
  }
  const normalizedIssueNumber = positiveIssueNumber(issueNumber)
  const normalizedTask = normalizeTask(task, normalizedIssueNumber)
  const canonical = JSON.stringify({
    protocol: MARKER,
    repository: repository.toLowerCase(),
    issueNumber: normalizedIssueNumber,
    task: normalizedTask,
  })
  return `task-${createHash('sha256').update(canonical).digest('hex')}`
}

/**
 * @param {TaskEligibilityInput} [input]
 */
export function decideTaskEligibility({
  repository,
  issue,
  trustedAuthor = false,
  dependencies = [],
  activeTaskIds = [],
  hasOpenPullRequest = false,
} = {}) {
  const issueRecord = issue && typeof issue === 'object' && !Array.isArray(issue)
    ? /** @type {Record<string, unknown>} */ (issue)
    : null
  if (!issueRecord || issueRecord.state !== 'open') return { status: 'terminal', reason: 'issue-not-open' }
  if (!trustedAuthor) return { status: 'invalid', reason: 'untrusted-author' }

  /** @type {TaskDeclaration | null} */
  let task
  try {
    task = parseTaskDeclaration(issueRecord.body, { issueNumber: issueRecord.number })
  } catch (error) {
    return {
      status: 'invalid',
      reason: 'invalid-declaration',
      detail: error instanceof Error ? error.message : String(error),
    }
  }
  if (!task) return { status: 'ineligible', reason: 'missing-declaration' }

  const taskId = taskIdentity({ repository, issueNumber: issueRecord.number, task })
  if (task.dispatch === 'hold') return { status: 'hold', reason: 'dispatch-hold', taskId, task }
  if (hasOpenPullRequest) return { status: 'active', reason: 'open-pull-request', taskId, task }
  if (activeTaskIds.includes(taskId)) return { status: 'active', reason: 'claimed', taskId, task }

  /** @type {Map<number, NormalizedDependencyObservation>} */
  const byNumber = new Map()
  /** @type {Set<number>} */
  const conflictingDependencies = new Set()
  for (const dependency of dependencies) {
    if (!dependency || typeof dependency !== 'object' || Array.isArray(dependency)) continue
    const record = /** @type {Record<string, unknown>} */ (dependency)
    if (!Number.isSafeInteger(record.number)) continue
    const number = /** @type {number} */ (record.number)
    const normalized = { number, state: record.state, type: record.type }
    const previous = byNumber.get(number)
    if (!previous) byNumber.set(number, normalized)
    else if (previous.state !== normalized.state || previous.type !== normalized.type) {
      conflictingDependencies.add(number)
    }
  }

  /** @type {number[]} */
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
