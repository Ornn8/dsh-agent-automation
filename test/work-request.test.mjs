import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createReviewRepairRequest,
  createIssueImplementationRequest,
  isReviewRepairRequestId,
  parseAgentWorkRequest,
  repositoryDispatchBody,
} from '../src/work-request.mjs'

const base = 'a'.repeat(40)
const head = 'b'.repeat(40)

test('review repair is an immutable role request rather than an agent command', () => {
  const request = createReviewRepairRequest({
    repository: 'owner/repository',
    pullRequestNumber: 12,
    base,
    head,
  })

  assert.deepEqual(request, {
    version: 1,
    requestId: `review-repair-${base}-${head}`,
    role: 'change',
    kind: 'review-repair',
    repository: 'owner/repository',
    subject: { type: 'pull-request', number: 12 },
    revision: { base, head },
  })
  assert.equal(request.workerId, undefined)
  assert.match(request.requestId, /^[A-Za-z0-9._-]{1,100}$/)
  assert.equal(isReviewRepairRequestId(request.requestId, head), true)
  assert.equal(isReviewRepairRequestId(request.requestId, base), false)
})

test('issue implementation requests use the same typed subject format as pull request work', () => {
  const request = createIssueImplementationRequest({ repository: 'owner/repository', issueNumber: 7, base })
  assert.deepEqual(request.subject, { type: 'issue', number: 7 })
  assert.equal(request.kind, 'issue-implementation')
  assert.throws(() => parseAgentWorkRequest({ ...request, subject: { type: 'pull-request', number: 7 } }), /subject/)
})

test('repository dispatch transports the complete work request', () => {
  const request = createReviewRepairRequest({
    repository: 'owner/repository', pullRequestNumber: 12, base, head,
  })
  assert.deepEqual(repositoryDispatchBody(request), {
    event_type: 'agent_work_requested',
    client_payload: request,
  })
})

test('work request parsing fails closed on an unknown role or mutable revision', () => {
  const request = createReviewRepairRequest({
    repository: 'owner/repository', pullRequestNumber: 12, base, head,
  })
  assert.throws(() => parseAgentWorkRequest({ ...request, role: 'dsh' }), /role/)
  assert.throws(() => parseAgentWorkRequest({ ...request, revision: { base, head: 'main' } }), /revision/)
})
