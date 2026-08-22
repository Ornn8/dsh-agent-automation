import { trustedControllerMutation } from './controller-mutation-marker.mjs'
import { parseAgentAutomationVerificationReceipt } from './agent-work-result.mjs'

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const HASH = /^[0-9a-f]{64}$/
const WORKER_VERIFICATION_MARKER = '<!-- agent-worker-verification:v1\n'
const WORKER_VERIFICATION_TRAILER = '\n-->'
const MAX_WORKER_VERIFICATION_BYTES = 8 * 1024

/** Verify one Worker status comment against its controller-authenticated run. */
export async function trustedWorkerIdentity(comment, subject, operation, repository, loadRun, expectedControllerLogin) {
  if (!comment?.user?.login) return null
  try {
    const record = await trustedControllerMutation({
      comment,
      expectedControllerLogin,
      expectedRepository: repository,
      expectedSubject: subject,
      loadRun,
    })
    if (record.operation !== operation) return null
    return parseWorkflowIdentity(comment.body)
  } catch {
    return null
  }
}

/** Parse the Profile identity written by a controller Worker status comment. */
export function parseWorkflowIdentity(body) {
  const text = String(body || '')
  const profileId = /^- Profile: `([^`]+)`$/m.exec(text)?.[1] || ''
  const workflowId = /^- Workflow: `([^`]+)`$/m.exec(text)?.[1] || ''
  const definitionHash = /^- Definition hash: `([^`]+)`$/m.exec(text)?.[1] || ''
  const branch = /^- Branch: `([^`]+)`$/m.exec(text)?.[1] || ''
  if (!ID.test(profileId) || !ID.test(workflowId) || !HASH.test(definitionHash) || !branch) return null
  const verification = parseWorkerVerificationObservation(text)
  return verification ? { profileId, workflowId, definitionHash, branch, verification }
    : { profileId, workflowId, definitionHash, branch }
}

/** Render one bounded versioned v2 receipt inside the existing Worker status comment. */
export function renderWorkerVerificationObservation(receipt) {
  const verification = parseAgentAutomationVerificationReceipt(receipt)
  const encoded = JSON.stringify({ version: 1, verification })
  const rendered = `${WORKER_VERIFICATION_MARKER}${encoded}${WORKER_VERIFICATION_TRAILER}`
  if (Buffer.byteLength(rendered, 'utf8') > MAX_WORKER_VERIFICATION_BYTES) {
    throw new Error('Worker verification observation exceeds its bound')
  }
  return rendered
}

/** Parse one persisted Worker receipt, returning null for malformed or duplicated observations. */
export function parseWorkerVerificationObservation(body) {
  const text = String(body || '')
  const start = text.indexOf(WORKER_VERIFICATION_MARKER)
  if (start < 0 || text.indexOf(WORKER_VERIFICATION_MARKER, start + 1) >= 0) return null
  const contentStart = start + WORKER_VERIFICATION_MARKER.length
  const end = text.indexOf(WORKER_VERIFICATION_TRAILER, contentStart)
  if (end < 0) return null
  const rendered = text.slice(start, end + WORKER_VERIFICATION_TRAILER.length)
  if (Buffer.byteLength(rendered, 'utf8') > MAX_WORKER_VERIFICATION_BYTES) return null
  try {
    const value = JSON.parse(text.slice(contentStart, end))
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || value.version !== 1 || Object.keys(value).sort().join(',') !== 'verification,version') return null
    return parseAgentAutomationVerificationReceipt(value.verification)
  } catch {
    return null
  }
}
