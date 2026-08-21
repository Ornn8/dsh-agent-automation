import assert from 'node:assert/strict'
import test from 'node:test'

import { ciRepairRequest } from '../src/dispatch-policy.mjs'
import {
  trustedRepairRecoveryRequestId,
  interruptedRepairMayRetry,
  repairRoutingEvidence,
  recoverableRepairIdentity,
  recordedRepairStatus,
  recordedRepairState,
} from '../src/repair-state.mjs'
import { classifyAndCreateWorkerRouteDecision } from '../src/worker-routing.mjs'

const controllerSha = 'a'.repeat(40)

function repairStatus({ marker = 'request', sha = controllerSha, repairClass = 'automatic-review', status = 'failed', runId = null, stageId = null, ciWorkflow = null } = {}) {
  return [
    `<!-- dsh-review-repair:${sha}:${'c'.repeat(40)}:${marker} -->`,
    '### DSH repair',
    '',
    `- Status: **${status}**`,
    ...(runId ? [`- Run: https://github.com/Ornn8/deepseek-harness/actions/runs/${runId}`] : []),
    `- Controller SHA: \`${sha}\``,
    `- Repair class: \`${repairClass}\``,
    ...(stageId ? [`- Stage: \`${stageId}\``] : []),
    ...(ciWorkflow ? [`- CI workflow: \`${ciWorkflow}\``] : []),
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
    workflowStage: null,
    ciWorkflow: null,
    originalRequestId: null,
  })
})

test('recovery identity restores immutable repair routing evidence and rejects contradictory source lines', () => {
  const sourceRun = 31775196648
  const head = 'c'.repeat(40)
  const source = (repairClass, extra = {}) => [
    `<!-- dsh-review-repair:${controllerSha}:${head}:review-repair-${head}-comment-7 -->`,
    '- Status: **failed**',
    `- Controller SHA: \`${controllerSha}\``,
    `- Repair class: \`${repairClass}\``,
    `- Reviewed head: \`${head}\``,
    `- Run: https://github.com/Ornn8/deepseek-harness/actions/runs/${sourceRun}`,
    ...(extra.stageId ? [`- Stage: \`${extra.stageId}\``] : []),
    ...(extra.ciWorkflow ? [`- CI workflow: \`${extra.ciWorkflow}\``] : []),
  ].join('\n')

  assert.deepEqual(recoverableRepairIdentity({
    requestId: `recovery-${sourceRun}-1`,
    comments: [{ user: { login: 'controller' }, body: source('automatic-merge', { stageId: 'change' }) }],
    controllerSha,
    expectedHead: head,
    markerAuthor: 'controller',
    repository: 'Ornn8/deepseek-harness',
  }), {
    requestId: `recovery-${sourceRun}-1`,
    originalRequestId: `review-repair-${head}-comment-7`,
    sourceRunId: String(sourceRun),
    sourceStatus: 'failed',
    repairClass: 'automatic-merge',
    repairCause: 'merge-conflict',
    repairCode: 'merge-conflict',
    workflowStage: 'change',
    ciWorkflow: null,
  })

  assert.deepEqual(recoverableRepairIdentity({
    requestId: `recovery-${sourceRun}-1`,
    comments: [{ user: { login: 'controller' }, body: source('explicit-human') }],
    controllerSha,
    expectedHead: head,
    markerAuthor: 'controller',
    repository: 'Ornn8/deepseek-harness',
  }).workflowStage, 'repair')

  assert.deepEqual(recoverableRepairIdentity({
    requestId: `recovery-${sourceRun}-1`,
    comments: [{ user: { login: 'controller' }, body: source('automatic-ci', { ciWorkflow: 'CI' }) }],
    controllerSha,
    expectedHead: head,
    markerAuthor: 'controller',
    repository: 'Ornn8/deepseek-harness',
  }).repairCode, 'CI')

  for (const body of [
    source('automatic-review', { ciWorkflow: 'CI' }),
    source('automatic-ci'),
    source('automatic-review', { stageId: 'bad stage' }),
    source('automatic-review').replace('- Repair class: `automatic-review`', '- Repair class: `automatic-review`\n- Repair class: `automatic-merge`'),
  ]) {
    assert.throws(() => recoverableRepairIdentity({
      requestId: `recovery-${sourceRun}-1`,
      comments: [{ user: { login: 'controller' }, body }],
      controllerSha,
      expectedHead: head,
      markerAuthor: 'controller',
      repository: 'Ornn8/deepseek-harness',
    }), /trusted repair source comment/)
  }
})

test('recovery-of-recovery follows only a strict original request marker', () => {
  const sourceRun = 31775196649
  const head = 'c'.repeat(40)
  const originalRequestId = `review-repair-${head}-run-7`
  const recoveryBody = [
    `<!-- dsh-review-repair:${controllerSha}:${head}:recovery-31775196648-1 -->`,
    '- Status: **failed**',
    `- Controller SHA: \`${controllerSha}\``,
    '- Repair class: `explicit-human`',
    '- Stage: `change`',
    `- Original request: \`${originalRequestId}\``,
    `- Reviewed head: \`${head}\``,
    `- Run: https://github.com/Ornn8/deepseek-harness/actions/runs/${sourceRun}`,
  ].join('\n')
  const identity = recoverableRepairIdentity({
    requestId: `recovery-${sourceRun}-2`,
    comments: [{ user: { login: 'controller' }, body: recoveryBody }],
    controllerSha,
    expectedHead: head,
    markerAuthor: 'controller',
    repository: 'Ornn8/deepseek-harness',
  })
  assert.equal(identity.originalRequestId, originalRequestId)
  assert.equal(identity.workflowStage, 'change')

  for (const body of [
    recoveryBody.replace(`- Original request: \`${originalRequestId}\`\n`, ''),
    recoveryBody.replace(originalRequestId, 'recovery-31775196648-1'),
    recoveryBody.replace(`- Original request: \`${originalRequestId}\``, `- Original request: \`${originalRequestId}\`\n- Original request: \`${originalRequestId}\``),
  ]) {
    assert.throws(() => recoverableRepairIdentity({
      requestId: `recovery-${sourceRun}-2`,
      comments: [{ user: { login: 'controller' }, body }],
      controllerSha,
      expectedHead: head,
      markerAuthor: 'controller',
      repository: 'Ornn8/deepseek-harness',
    }), /trusted repair source comment/)
  }
})

test('CI recovery keeps the original source comment when recovery comments share its request id', () => {
  const originalRun = 31775196648
  const recoveryRun = 31775196649
  const head = 'c'.repeat(40)
  const originalRequestId = 'ci-run-81-2'
  const comment = (markerRequestId, runId, originalRequest = null) => [
    `<!-- dsh-review-repair:${controllerSha}:${head}:${markerRequestId} -->`,
    '- Status: **failed**',
    `- Controller SHA: \`${controllerSha}\``,
    '- Repair class: `automatic-ci`',
    '- Stage: `repair`',
    '- CI workflow: `CI`',
    ...(originalRequest ? [`- Original request: \`${originalRequest}\``] : []),
    `- Reviewed head: \`${head}\``,
    `- Run: https://github.com/Ornn8/deepseek-harness/actions/runs/${runId}`,
  ].join('\n')

  const identity = recoverableRepairIdentity({
    requestId: `${originalRequestId}.recovery-2`,
    comments: [
      { user: { login: 'controller' }, body: comment(originalRequestId, originalRun) },
      { user: { login: 'controller' }, body: comment('recovery-31775196648-1', recoveryRun, originalRequestId) },
    ],
    controllerSha,
    expectedHead: head,
    markerAuthor: 'controller',
    repository: 'Ornn8/deepseek-harness',
  })
  assert.equal(identity.originalRequestId, originalRequestId)
  assert.equal(identity.sourceRunId, String(originalRun))
})

test('recovery dispatch restores the root CI request before dsh-repair replay', () => {
  const sourceRun = 31775196649
  const head = 'c'.repeat(40)
  const body = [
    `<!-- dsh-review-repair:${controllerSha}:${head}:ci-run-81-2.recovery-1 -->`,
    '- Status: **failed**',
    `- Controller SHA: \`${controllerSha}\``,
    '- Repair class: `automatic-ci`',
    '- Stage: `repair`',
    '- Original request: `ci-run-81-2`',
    '- CI workflow: `CI`',
    `- Reviewed head: \`${head}\``,
    `- Run: https://github.com/Ornn8/deepseek-harness/actions/runs/${sourceRun}`,
  ].join('\n')

  const rootRequestId = trustedRepairRecoveryRequestId({
    comment: { user: { login: 'controller' }, body },
    controllerSha,
    expectedHead: head,
    sourceRunId: String(sourceRun),
    markerAuthor: 'controller',
    repository: 'Ornn8/deepseek-harness',
  })
  assert.equal(rootRequestId, 'ci-run-81-2')
  assert.deepEqual(ciRepairRequest(`${rootRequestId}.recovery-2`), {
    kind: 'run', runId: 81, attempt: 2,
  })
  assert.equal(trustedRepairRecoveryRequestId({
    comment: { user: { login: 'controller' }, body: body.replace('- Original request: `ci-run-81-2`\n', '') },
    controllerSha,
    expectedHead: head,
    sourceRunId: String(sourceRun),
    markerAuthor: 'controller',
    repository: 'Ornn8/deepseek-harness',
  }), null)
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
    '- Repair class: `automatic-ci`',
    '- CI workflow: `CI`',
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
    repairClass: 'automatic-ci',
    repairCause: 'CI',
    repairCode: 'CI',
    workflowStage: 'repair',
    ciWorkflow: 'CI',
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
