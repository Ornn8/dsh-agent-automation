import test from 'node:test'
import assert from 'node:assert/strict'

import {
  capacityWaitStatusLine,
  createCapacityWaitProjection,
  parseCapacityWaitProjection,
  parseCapacityWaitStatus,
} from '../src/capacity-wait-projection.mjs'

const stateVersion = 'a'.repeat(64)
const projectionInput = {
  workRequestId: 'issue-request-17',
  role: 'change',
  profileId: 'github-pr-cycle',
  workflowId: 'issue-work',
  stageId: 'change',
  definitionHash: 'b'.repeat(64),
  revision: { base: 'f'.repeat(40), head: 'f'.repeat(40) },
  subject: { type: 'issue', number: 17, stateVersion },
  routeDecision: {
    version: 1,
    workRequestId: 'issue-request-17',
    role: 'change',
    stateVersion,
    taskClass: 'frontend',
    policyHash: 'c'.repeat(64),
    evidenceHash: 'd'.repeat(64),
  },
  capacityGenerationHash: 'e'.repeat(64),
  observationId: 'run-100:1',
}

test('CapacityWaitProjection v1 round-trips a sanitized exact request and route', () => {
  const projection = createCapacityWaitProjection(projectionInput)
  const parsed = parseCapacityWaitProjection(projection)
  assert.deepEqual(parsed, { version: 1, ...projectionInput })
  assert.deepEqual(parseCapacityWaitStatus(capacityWaitStatusLine(projection)), parsed)
})

test('CapacityWaitProjection rejects identity, subject, route, and secret-like fields', () => {
  const projection = createCapacityWaitProjection(projectionInput)
  assert.throws(() => parseCapacityWaitProjection({ ...projection, routeDecision: { ...projection.routeDecision, stateVersion: 'f'.repeat(64) } }), /routeDecision.*subject/)
  assert.throws(() => parseCapacityWaitProjection({ ...projection, subject: { ...projection.subject, number: 0 } }), /subject.number/)
  assert.throws(() => parseCapacityWaitProjection({ ...projection, secret: 'token' }), /unknown field/)
  assert.throws(() => parseCapacityWaitStatus(`${capacityWaitStatusLine(projection)}\n${capacityWaitStatusLine(projection)}`), /exactly one/)
})
