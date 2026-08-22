import test from 'node:test'
import assert from 'node:assert/strict'
import {
  capacityResumeRequestId,
  capacityWaitStatusLine,
  createCapacityWaitProjection,
  createIssueCapacityWaitProjection,
  parseCapacityWaitProjection,
  parseCapacityWaitStatus,
} from '../src/capacity-wait-projection.mjs'
const stateVersion = 'a'.repeat(64)
const projectionInput = {
  workRequestId: 'issue-request-17',
  role: 'change',
  repository: 'Ornn8/deepseek-harness',
  profileId: 'github-pr-cycle',
  workflowId: 'issue-work',
  stageId: 'change',
  definitionHash: 'b'.repeat(64),
  revision: { base: 'f'.repeat(40), head: 'f'.repeat(40) },
  coordinationKey: 'Ornn8/deepseek-harness:github-pr-cycle:issue-work',
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

test('Issue capacity-deferred publication carries the trusted WorkRequest and current subject state', () => {
  const projection = createIssueCapacityWaitProjection({
    workRequest: {
      requestId: projectionInput.workRequestId,
      profileId: projectionInput.profileId,
      workflowId: projectionInput.workflowId,
      stageId: projectionInput.stageId,
      definitionHash: projectionInput.definitionHash,
      role: projectionInput.role,
      repository: projectionInput.repository,
      subject: { type: 'issue', number: projectionInput.subject.number },
      revision: projectionInput.revision,
      coordinationKey: projectionInput.coordinationKey,
    },
    issueNumber: projectionInput.subject.number,
    subjectStateVersion: stateVersion,
    routeDecision: projectionInput.routeDecision,
    capacityGenerationHash: projectionInput.capacityGenerationHash,
    observationId: projectionInput.observationId,
  })
  assert.deepEqual(projection, createCapacityWaitProjection(projectionInput))
  assert.equal(capacityWaitStatusLine(projection), capacityWaitStatusLine(createIssueCapacityWaitProjection({
    workRequest: {
      requestId: projectionInput.workRequestId,
      profileId: projectionInput.profileId,
      workflowId: projectionInput.workflowId,
      stageId: projectionInput.stageId,
      definitionHash: projectionInput.definitionHash,
      role: projectionInput.role,
      repository: projectionInput.repository,
      subject: { type: 'issue', number: projectionInput.subject.number },
      revision: projectionInput.revision,
      coordinationKey: projectionInput.coordinationKey,
    },
    issueNumber: projectionInput.subject.number,
    subjectStateVersion: stateVersion,
    routeDecision: projectionInput.routeDecision,
    capacityGenerationHash: projectionInput.capacityGenerationHash,
    observationId: projectionInput.observationId,
  })))
  assert.doesNotMatch(capacityWaitStatusLine(projection), /provider|model|account|credential|raw response/i)
})

test('Issue capacity-deferred publication fails closed without trusted route or generation evidence', () => {
  const input = {
    workRequest: {
      requestId: projectionInput.workRequestId,
      profileId: projectionInput.profileId,
      workflowId: projectionInput.workflowId,
      stageId: projectionInput.stageId,
      definitionHash: projectionInput.definitionHash,
      role: projectionInput.role,
      repository: projectionInput.repository,
      subject: { type: 'issue', number: projectionInput.subject.number },
      revision: projectionInput.revision,
      coordinationKey: projectionInput.coordinationKey,
    },
    issueNumber: projectionInput.subject.number,
    subjectStateVersion: stateVersion,
    routeDecision: projectionInput.routeDecision,
    capacityGenerationHash: projectionInput.capacityGenerationHash,
    observationId: projectionInput.observationId,
  }
  assert.throws(() => createIssueCapacityWaitProjection({ ...input, routeDecision: undefined }), /routeDecision/i)
  assert.throws(() => createIssueCapacityWaitProjection({
    ...input,
    routeDecision: { ...projectionInput.routeDecision, workRequestId: 'other-request' },
  }), /routeDecision/i)
  assert.throws(() => createIssueCapacityWaitProjection({ ...input, capacityGenerationHash: undefined }), /capacityGenerationHash/i)
  assert.throws(() => createIssueCapacityWaitProjection({ ...input, capacityGenerationHash: 'not-a-digest' }), /capacityGenerationHash/i)
})
test('CapacityWaitProjection rejects identity, subject, route, and secret-like fields', () => {
  const projection = createCapacityWaitProjection(projectionInput)
  assert.throws(
    () => parseCapacityWaitProjection({ ...projection, routeDecision: { ...projection.routeDecision, stateVersion: 'f'.repeat(64) } }),
    /routeDecision.*subject/,
  )
  assert.throws(
    () => parseCapacityWaitProjection({ ...projection, subject: { ...projection.subject, number: 0 } }),
    /subject.number/,
  )
  assert.throws(() => parseCapacityWaitProjection({ ...projection, secret: 'token' }), /unknown field/)
  assert.throws(() => parseCapacityWaitProjection({ ...projection, repository: undefined }), /repository/)
  assert.throws(() => parseCapacityWaitProjection({ ...projection, coordinationKey: '' }), /coordinationKey/)
  assert.throws(
    () => parseCapacityWaitStatus(`${capacityWaitStatusLine(projection)}\n${capacityWaitStatusLine(projection)}`),
    /exactly one/,
  )
})
test('capacity resume identity binds the complete projection and exact route identity', () => {
  const projection = createCapacityWaitProjection(projectionInput)
  const requestId = capacityResumeRequestId(projection)
  assert.match(requestId, /^capacity-resume-[0-9a-f]{64}$/)
  assert.notEqual(requestId, capacityResumeRequestId({
    ...projection,
    capacityGenerationHash: 'f'.repeat(64),
  }))
  assert.notEqual(requestId, capacityResumeRequestId({
    ...projection,
    subject: { ...projection.subject, stateVersion: 'f'.repeat(64) },
    routeDecision: { ...projection.routeDecision, stateVersion: 'f'.repeat(64) },
  }))
  assert.notEqual(requestId, capacityResumeRequestId({
    ...projection,
    repository: 'Other/repository',
  }))
  assert.notEqual(requestId, capacityResumeRequestId({
    ...projection,
    coordinationKey: 'Other/repository:github-pr-cycle:issue-work',
  }))
  assert.notEqual(requestId, capacityResumeRequestId({
    ...projection,
    routeDecision: { ...projection.routeDecision, policyHash: 'f'.repeat(64) },
  }))
})
