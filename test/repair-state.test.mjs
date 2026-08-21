import assert from 'node:assert/strict'
import test from 'node:test'

import {
  interruptedRepairMayRetry,
  repairRoutingEvidence,
  recoverableRepairIdentity,
  recordedRepairStatus,
  recordedRepairState,
} from '../src/repair-state.mjs'
import { classifyAndCreateWorkerRouteDecision } from '../src/worker-routing.mjs'

const controllerSha = 'a'.repeat(40)

function repairStatus({ marker = 'request', sha = controllerSha, repairClass = 'automatic-review', status = 'failed', runId = null } = {}) {
  return [
    `<!-- dsh-review-repair:${sha}:${'c'.repeat(40)}:${marker} -->`,
    '### DSH repair',
    '',
    `- Status: **${status}**`,
    ...(runId ? [`- Run: https://github.com/Ornn8/deepseek-harness/actions/runs/${runId}`] : []),
    `- Controller SHA: \`${sha}\``,
    `- Repair class: \`${repairClass}\``,
  ].join('\n')
}

const workRequest = { requestId: 'review-repair-request', role: 'change' }
const stateVersion = 'b'.repeat(64)
const routingPolicy = {
  version: 1,
  default: 'default',
  classificationOrder: ['frontend'],
  routes: {
    frontend: { rules: { pathPrefixes: ['web/'] } },
    default: { rules: {} },
  },
}

test('repair status exposes controller provenance only as audit metadata', () => {
  const status = recordedRepairStatus(repairStatus({ marker: 'limit', repairClass: 'automatic-ci', status: 'dead-letter' }))
  assert.deepEqual(status, {
    marker: `<!-- dsh-review-repair:${controllerSha}:${'c'.repeat(40)}:limit -->`,
    controllerSha,
    repairClass: 'automatic-ci',
    status: 'dead-letter',
    runId: null,
  })
})

test('repair route evidence excludes mutable metadata while exact paths and generations remain decisive', () => {
  const firstEvidence = repairRoutingEvidence({
    paths: ['web/Button.tsx'],
    workflowStage: 'repair',
    failureEvidence: { class: 'automatic-review', code: 'review-repair' },
    title: 'frontend repair',
    body: 'labels: automation/ci-failed',
    labels: ['automation/ci-failed'],
  })
  const changedMetadataEvidence = repairRoutingEvidence({
    paths: ['web/Button.tsx'],
    workflowStage: 'repair',
    failureEvidence: { class: 'automatic-review', code: 'review-repair' },
    title: 'ordinary repair',
    body: 'labels: automation/repairing',
    labels: ['automation/repairing'],
  })
  const decision = classifyAndCreateWorkerRouteDecision({
    workRequest,
    stateVersion,
    routingPolicy,
    trustedTaskSnapshot: firstEvidence,
  })
  const resumed = classifyAndCreateWorkerRouteDecision({
    workRequest,
    stateVersion,
    routingPolicy,
    trustedTaskSnapshot: changedMetadataEvidence,
  })
  const changedPaths = classifyAndCreateWorkerRouteDecision({
    workRequest,
    stateVersion,
    routingPolicy,
    trustedTaskSnapshot: repairRoutingEvidence({
      paths: ['src/api.ts'],
      workflowStage: 'repair',
      failureEvidence: { class: 'automatic-review', code: 'review-repair' },
    }),
  })
  const newGeneration = classifyAndCreateWorkerRouteDecision({
    workRequest,
    stateVersion: 'c'.repeat(64),
    routingPolicy,
    trustedTaskSnapshot: firstEvidence,
  })

  assert.equal(resumed.taskClass, 'frontend')
  assert.equal(resumed.evidenceHash, decision.evidenceHash)
  assert.notEqual(changedPaths.taskClass, resumed.taskClass)
  assert.notEqual(newGeneration.stateVersion, resumed.stateVersion)
})

test('capacity waiting is re-entrant while terminal repair states remain closed', () => {
  const body = repairStatus({ status: 'capacity-waiting', runId: 31775196648 })
  assert.equal(recordedRepairState(body).status, 'capacity-waiting')
  assert.equal(interruptedRepairMayRetry(body, {
    id: 31775196648,
    status: 'completed',
    conclusion: 'success',
  }), true)
  for (const status of ['complete', 'failed', 'dead-letter']) {
    assert.equal(interruptedRepairMayRetry(repairStatus({ status }), {
      id: 31775196648,
      status: 'completed',
      conclusion: 'success',
    }), false)
  }
})

test('recovery identity restores the exact source WorkRequest and rejects untrusted evidence', () => {
  const sourceRun = 31775196648
  const source = [
    `<!-- dsh-review-repair:${controllerSha}:${'c'.repeat(40)}:ci-run-81-2 -->`,
    '- Status: **failed**',
    `- Controller SHA: \`${controllerSha}\``,
    '- Reviewed head: `' + 'c'.repeat(40) + '`',
    `- Run: https://github.com/Ornn8/deepseek-harness/actions/runs/${sourceRun}`,
  ].join('\n')
  const comments = [{ user: { login: 'controller' }, body: source }]

  assert.deepEqual(recoverableRepairIdentity({
    requestId: 'ci-run-81-2.recovery-3',
    comments,
    controllerSha,
    expectedHead: 'c'.repeat(40),
    markerAuthor: 'controller',
    repository: 'Ornn8/deepseek-harness',
  }), {
    requestId: 'ci-run-81-2.recovery-3',
    originalRequestId: 'ci-run-81-2',
    sourceRunId: String(sourceRun),
    sourceStatus: 'failed',
  })
  assert.deepEqual(recoverableRepairIdentity({
    requestId: `recovery-${sourceRun}-1`,
    comments,
    controllerSha,
    expectedHead: 'c'.repeat(40),
    markerAuthor: 'controller',
    repository: 'Ornn8/deepseek-harness',
  }).originalRequestId, 'ci-run-81-2')
  assert.throws(() => recoverableRepairIdentity({
    requestId: `recovery-${sourceRun}-1`,
    comments: [{ user: { login: 'attacker' }, body: source }],
    controllerSha,
    expectedHead: 'c'.repeat(40),
    markerAuthor: 'controller',
    repository: 'Ornn8/deepseek-harness',
  }), /trusted repair source comment/)
  assert.throws(() => recoverableRepairIdentity({
    requestId: 'recovery-99-1',
    comments,
    controllerSha,
    expectedHead: 'c'.repeat(40),
    markerAuthor: 'controller',
    repository: 'Ornn8/deepseek-harness',
  }), /trusted repair source comment/)
  assert.throws(() => recoverableRepairIdentity({
    requestId: 'ci-run-81-2.recovery-3',
    comments: [{ user: { login: 'controller' }, body: source.replace('Reviewed head: `' + 'c'.repeat(40), 'Reviewed head: `' + 'd'.repeat(40)) }],
    controllerSha,
    expectedHead: 'c'.repeat(40),
    markerAuthor: 'controller',
    repository: 'Ornn8/deepseek-harness',
  }), /trusted repair source comment/)
})
