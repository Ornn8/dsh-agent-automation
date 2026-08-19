import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createReviewRepairRequest,
  createIssueImplementationRequest,
  createStageWorkRequest,
  isReviewRepairRequestId,
  parseAgentWorkRequest,
  reviewRepairTransition,
  repositoryDispatchBody,
} from '../src/work-request.mjs'
import { loadWorkflowProfile } from '../src/workflow-profile.mjs'
import { workflowDefinitionHash } from '../src/workflow-definition.mjs'

const base = 'a'.repeat(40)
const head = 'b'.repeat(40)
const reviewObservationId = 'run-31944175917'
const profile = await loadWorkflowProfile()

test('review repair is an immutable Stage request rather than an agent command', () => {
  const request = createReviewRepairRequest({
    ...profile,
    repository: 'owner/repository',
    pullRequestNumber: 12,
    base,
    head,
    reviewObservationId,
  })

  assert.deepEqual(request, {
    version: 2,
    requestId: `review-repair-${head}-${reviewObservationId}`,
    profileId: 'github-pr-cycle',
    workflowId: 'repair',
    stageId: 'change',
    definitionHash: profile.definitionHash,
    role: 'change',
    repository: 'owner/repository',
    subject: { type: 'pull-request', number: 12 },
    revision: { base, head },
    coordinationKey: 'owner/repository:github-pr-cycle:repair',
  })
  assert.equal(request.workerId, undefined)
  assert.equal(request.procedure, undefined)
  assert.equal(isReviewRepairRequestId(request.requestId, head), true)
  assert.equal(isReviewRepairRequestId(request.requestId, base), false)
  assert.equal(reviewRepairTransition(reviewObservationId), `review-repair:${reviewObservationId}`)
})

test('advancement repair ids bind the complete deterministic transition identity', () => {
  const observationId = `advance-${'d'.repeat(64)}`
  const request = createReviewRepairRequest({
    ...profile,
    repository: 'owner/repository',
    pullRequestNumber: 12,
    base,
    head,
    reviewObservationId: observationId,
  })
  assert.equal(reviewRepairTransition(observationId), `review-repair:${observationId}`)
  assert.equal(isReviewRepairRequestId(request.requestId, head), true)
  assert.equal(isReviewRepairRequestId(request.requestId, base), false)
})

test('review repair resolves the unique repair Stage from a custom Profile workflow', () => {
  const definition = structuredClone(profile.definition)
  definition.profileId = 'custom-profile'
  definition.workflows['pull-request-fix'] = {
    ...definition.workflows.repair,
    stages: [{ ...definition.workflows.repair.stages[0], id: 'repair-change' }],
  }
  delete definition.workflows.repair
  const request = createReviewRepairRequest({
    definition,
    definitionHash: workflowDefinitionHash(definition),
    repository: 'owner/repository',
    pullRequestNumber: 12,
    base,
    head,
    reviewObservationId: 'comment-42',
  })
  assert.equal(request.profileId, 'custom-profile')
  assert.equal(request.workflowId, 'pull-request-fix')
  assert.equal(request.stageId, 'repair-change')
  assert.equal(request.requestId, `review-repair-${head}-comment-42`)
})

test('Issue requests resolve their root Stage and bind the Profile hash', () => {
  const request = createIssueImplementationRequest({
    ...profile,
    workflowId: 'default',
    repository: 'owner/repository',
    issueNumber: 7,
    base,
    requestId: 'agent-work-1234',
  })
  assert.equal(request.profileId, 'github-pr-cycle')
  assert.equal(request.workflowId, 'default')
  assert.equal(request.stageId, 'change')
  assert.equal(request.definitionHash, profile.definitionHash)
  assert.deepEqual(request.subject, { type: 'issue', number: 7 })
})

test('repository dispatch transports the complete WorkRequest', () => {
  const request = createReviewRepairRequest({
    ...profile, repository: 'owner/repository', pullRequestNumber: 12, base, head, reviewObservationId,
  })
  assert.deepEqual(repositoryDispatchBody(request), {
    event_type: 'agent_work_requested',
    client_payload: { work_request: request },
  })
  assert.deepEqual(Object.keys(repositoryDispatchBody(request).client_payload), ['work_request'])
})

test('WorkRequest parsing fails closed on unknown fields and mutable identities', () => {
  const request = createReviewRepairRequest({
    ...profile, repository: 'owner/repository', pullRequestNumber: 12, base, head, reviewObservationId,
  })
  assert.throws(() => parseAgentWorkRequest({ ...request, command: 'npm test' }), /unknown field command/)
  assert.throws(() => parseAgentWorkRequest({ ...request, revision: { base, head: 'main' } }), /revision/)
  assert.throws(() => parseAgentWorkRequest({ ...request, definitionHash: '0'.repeat(63) }), /definitionHash/)
})

test('Stage requests reject Profile hashes or Adapter kinds that do not match trusted data', () => {
  assert.throws(() => createStageWorkRequest({
    definition: profile.definition,
    definitionHash: '0'.repeat(64),
    workflowId: 'default',
    stageId: 'change',
    repository: 'owner/repository',
    subject: { type: 'issue', number: 7 },
    revision: { base, head: base },
    coordinationKey: 'owner/repository:github-pr-cycle:default',
  }), /does not match/)
  assert.throws(() => createStageWorkRequest({
    ...profile,
    workflowId: 'default',
    stageId: 'checks',
    repository: 'owner/repository',
    subject: { type: 'issue', number: 7 },
    revision: { base, head: base },
    coordinationKey: 'owner/repository:github-pr-cycle:default',
  }), /expected worker/)
})
