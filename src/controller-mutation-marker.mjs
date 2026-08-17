const MARKER = '<!-- agent-controller-mutation:v1\n'
const TRAILER = '\n-->'
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const FULL_SHA = /^[0-9a-f]{40}$/
const RUN_URL = /^https:\/\/github\.com\/([^/\s]+\/[^/\s]+)\/actions\/runs\/(\d+)$/
const OPERATIONS = new Map([
  ['change-worker', { subjectType: 'issue', workflowPath: '.github/workflows/dsh-issue.yml' }],
  ['repair-worker', { subjectType: 'pull-request', workflowPath: '.github/workflows/dsh-repair.yml' }],
])

function exactKeys(value, expected, description) {
  const keys = value && typeof value === 'object' && !Array.isArray(value)
    ? Object.keys(value).sort() : []
  const wanted = [...expected].sort()
  if (keys.length !== wanted.length || keys.some((key, index) => key !== wanted[index])) {
    throw new Error(`${description} has unexpected fields`)
  }
}

function validatedRecord(value) {
  exactKeys(value, ['version', 'operation', 'repository', 'subject', 'runUrl', 'controller'], 'Controller mutation marker')
  exactKeys(value?.subject, ['type', 'number'], 'Controller mutation subject')
  exactKeys(value?.controller, ['repository', 'workflowPath', 'sha'], 'Controller mutation source')
  const run = RUN_URL.exec(value?.runUrl || '')
  const operation = OPERATIONS.get(value?.operation)
  if (value?.version !== 1
    || !operation
    || !REPOSITORY.test(value.repository || '')
    || value.subject?.type !== operation.subjectType
    || !Number.isSafeInteger(value.subject?.number) || value.subject.number < 1
    || !run || run[1] !== value.repository
    || !REPOSITORY.test(value.controller?.repository || '')
    || value.controller?.workflowPath !== operation.workflowPath
    || !FULL_SHA.test(value.controller?.sha || '')) {
    throw new Error('Controller mutation marker is invalid')
  }
  return value
}

/** Render an audit-only marker for one host-credential Controller operation. */
export function controllerMutationMarker(record) {
  return `${MARKER}${JSON.stringify(validatedRecord(record))}${TRAILER}`
}

/** Parse one strict terminal Controller mutation marker. */
export function parseControllerMutationMarker(body) {
  const markerAt = typeof body === 'string' ? body.lastIndexOf(MARKER) : -1
  if (markerAt < 0 || markerAt !== body.indexOf(MARKER) || !body.endsWith(TRAILER)) {
    throw new Error('Controller mutation marker must be the unique terminal marker')
  }
  let value
  try {
    value = JSON.parse(body.slice(markerAt + MARKER.length, -TRAILER.length))
  } catch (error) {
    throw new Error(`Controller mutation marker is not valid JSON: ${error.message}`, { cause: error })
  }
  return validatedRecord(value)
}

/** Verify that an audit marker names the expected target, Actions run, and reusable Controller revision. */
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
