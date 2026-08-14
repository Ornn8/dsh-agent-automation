import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createReviewRepairRequest,
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
    requestId: `review-repair:${base}:${head}`,
    role: 'change',
    kind: 'review-repair',
    repository: 'owner/repository',
    subject: { type: 'pull-request', number: 12 },
    revision: { base, head },
  })
  assert.equal(request.workerId, undefined)
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
