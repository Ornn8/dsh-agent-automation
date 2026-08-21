import assert from 'node:assert/strict'
import test from 'node:test'

import {
  interruptedRepairMayRetry,
  recordedRepairRouteDecision,
  recordedRepairStatus,
  recordedRepairState,
} from '../src/repair-state.mjs'
import { classifyAndCreateWorkerRouteDecision, workerRouteDecisionBody } from '../src/worker-routing.mjs'

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
    frontend: { rules: { titleIncludes: ['frontend'] } },
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

test('repair status reuses one durable route decision when title and labels change', () => {
  const decision = classifyAndCreateWorkerRouteDecision({
    workRequest,
    stateVersion,
    routingPolicy,
    trustedTaskSnapshot: { title: 'frontend repair', labels: ['automation/ci-failed'] },
  })
  const body = [
    repairStatus({ status: 'capacity-waiting' }),
    workerRouteDecisionBody(decision),
  ].join('\n')

  const resumed = recordedRepairRouteDecision(body, {
    workRequest,
    stateVersion,
    routingPolicy,
  })
  const changedSnapshot = classifyAndCreateWorkerRouteDecision({
    workRequest,
    stateVersion,
    routingPolicy,
    trustedTaskSnapshot: { title: 'ordinary repair', labels: ['automation/repairing'] },
  })
  const newGeneration = classifyAndCreateWorkerRouteDecision({
    workRequest,
    stateVersion: 'c'.repeat(64),
    routingPolicy,
    trustedTaskSnapshot: { title: 'ordinary repair', labels: ['product-label'] },
  })

  assert.equal(resumed.taskClass, 'frontend')
  assert.equal(resumed.evidenceHash, decision.evidenceHash)
  assert.notEqual(changedSnapshot.taskClass, resumed.taskClass)
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
