import test from 'node:test'
import assert from 'node:assert/strict'
import { faultProjectionBody, parseFaultProjection } from '../src/fault-projection.mjs'

test('a root fault Issue is deterministic English projection rather than authorization', () => {
  const input = {
    repository: 'owner/product', component: 'change-worker', operation: 'recover-issue',
    failureClass: 'transport', errorCode: 'ECONNREFUSED', failureSignature: `workflow:${'a'.repeat(64)}`,
    rootRequestIds: ['request-2', 'request-1'], sourceRunId: 42,
    projectionRunId: 43, controllerRepository: 'owner/controller', controllerSha: '1'.repeat(40),
  }
  const body = faultProjectionBody(input)
  assert.match(body, /^<!-- agent-infrastructure-fault:v1:[0-9a-f]{64} -->/)
  assert.deepEqual(parseFaultProjection(body).rootRequestIds, ['request-1', 'request-2'])
  assert.equal(
    /^<!-- agent-infrastructure-fault:v1:[0-9a-f]{64} -->/.exec(body)[0],
    /^<!-- agent-infrastructure-fault:v1:[0-9a-f]{64} -->/.exec(faultProjectionBody({
      ...input,
      sourceRunId: 99,
      failureSignature: `workflow:${'b'.repeat(64)}`,
    }))[0],
  )
  assert.throws(() => parseFaultProjection(body.replace('ECONNREFUSED', 'AUTH_FAILED')), /fields are invalid/)
})
