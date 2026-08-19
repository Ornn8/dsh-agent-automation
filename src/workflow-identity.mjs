import { trustedControllerMutation } from './controller-mutation-marker.mjs'

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const HASH = /^[0-9a-f]{64}$/

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
  return { profileId, workflowId, definitionHash, branch }
}
