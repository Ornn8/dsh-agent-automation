// @ts-check

const MARKER = '<!-- agent-controller-mutation:v1\n'
const TRAILER = '\n-->'
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const FULL_SHA = /^[0-9a-f]{40}$/
const RUN_URL = /^https:\/\/github\.com\/([^/\s]+\/[^/\s]+)\/actions\/runs\/(\d+)$/
const OPERATIONS = new Map([
  ['change-worker', { subjectType: 'issue', workflowPath: '.github/workflows/dsh-issue.yml' }],
  ['repair-worker', { subjectType: 'pull-request', workflowPath: '.github/workflows/dsh-repair.yml' }],
])

/** @typedef {{ type: string, number: number }} MutationSubject */
/** @typedef {{ repository: string, workflowPath: string, sha: string }} ControllerSource */
/** @typedef {{ version: number, operation: string, repository: string, subject: MutationSubject, runUrl: string, controller: ControllerSource }} ControllerMutationRecord */
/** @typedef {{ user?: { login?: string }, body?: unknown }} MutationComment */
/** @typedef {{ id?: number, repository?: { full_name?: string }, referenced_workflows?: Array<{ path?: string, sha?: string }> }} WorkflowRun */

/** @param {unknown} value @param {string[]} expected @param {string} description */
function exactKeys(value, expected, description) {
  const keys = value && typeof value === 'object' && !Array.isArray(value)
    ? Object.keys(value).sort() : []
  const wanted = [...expected].sort()
  if (keys.length !== wanted.length || keys.some((key, index) => key !== wanted[index])) {
    throw new Error(`${description} has unexpected fields`)
  }
}

/** @param {unknown} value @returns {ControllerMutationRecord} */
function validatedRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Controller mutation marker is invalid')
  }
  const record = /** @type {ControllerMutationRecord} */ (value)
  exactKeys(value, ['version', 'operation', 'repository', 'subject', 'runUrl', 'controller'], 'Controller mutation marker')
  exactKeys(record.subject, ['type', 'number'], 'Controller mutation subject')
  exactKeys(record.controller, ['repository', 'workflowPath', 'sha'], 'Controller mutation source')
  const run = RUN_URL.exec(record.runUrl)
  const operation = OPERATIONS.get(record.operation)
  if (record.version !== 1
    || !operation
    || !REPOSITORY.test(record.repository)
    || record.subject?.type !== operation.subjectType
    || !Number.isSafeInteger(record.subject?.number) || record.subject.number < 1
    || !run || run[1] !== record.repository
    || !REPOSITORY.test(record.controller?.repository)
    || record.controller?.workflowPath !== operation.workflowPath
    || !FULL_SHA.test(record.controller?.sha)) {
    throw new Error('Controller mutation marker is invalid')
  }
  return record
}

/** Render an audit-only marker for one host-credential Controller operation. */
/** @param {unknown} record @returns {string} */
export function controllerMutationMarker(record) {
  return `${MARKER}${JSON.stringify(validatedRecord(record))}${TRAILER}`
}

/** Parse one strict terminal Controller mutation marker. */
/** @param {unknown} body @returns {ControllerMutationRecord} */
export function parseControllerMutationMarker(body) {
  const text = typeof body === 'string' ? body : ''
  const markerAt = text.lastIndexOf(MARKER)
  if (markerAt < 0 || markerAt !== text.indexOf(MARKER) || !text.endsWith(TRAILER)) {
    throw new Error('Controller mutation marker must be the unique terminal marker')
  }
  let value
  try {
    value = JSON.parse(text.slice(markerAt + MARKER.length, -TRAILER.length))
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`Controller mutation marker is not valid JSON: ${detail}`, { cause: error })
  }
  return validatedRecord(value)
}

/** Verify that an audit marker names the expected target, Actions run, and reusable Controller revision. */
/** @param {{ comment: MutationComment, markerAuthor: string, expectedRepository: string, expectedSubject: MutationSubject, loadRun: (runId: number) => WorkflowRun | Promise<WorkflowRun> }} input @returns {Promise<ControllerMutationRecord>} */
export async function trustedControllerMutation({ comment, markerAuthor, expectedRepository, expectedSubject, loadRun }) {
  if (typeof markerAuthor !== 'string' || !markerAuthor.trim()
    || !REPOSITORY.test(expectedRepository || '')
    || !['issue', 'pull-request'].includes(expectedSubject?.type)
    || !Number.isSafeInteger(expectedSubject?.number) || expectedSubject.number < 1
    || typeof loadRun !== 'function') {
    throw new Error('Controller mutation trust is incomplete')
  }
  if (comment?.user?.login !== markerAuthor) throw new Error('Controller mutation marker author is not trusted')
  const record = parseControllerMutationMarker(comment.body)
  if (record.repository !== expectedRepository
    || record.subject.type !== expectedSubject.type || record.subject.number !== expectedSubject.number) {
    throw new Error('Controller mutation marker does not identify the expected target')
  }
  const runMatch = RUN_URL.exec(record.runUrl)
  if (!runMatch) throw new Error('Controller mutation marker is invalid')
  const runId = Number.parseInt(runMatch[2], 10)
  const run = await loadRun(runId)
  const workflowReference = `${record.controller.repository}/${record.controller.workflowPath}@${record.controller.sha}`
  if (run?.id !== runId
    || run.repository?.full_name !== record.repository
    || !run.referenced_workflows?.some(reference => reference.path === workflowReference
      && reference.sha === record.controller.sha)) {
    throw new Error('Controller mutation marker is not backed by its named Actions run')
  }
  return record
}
