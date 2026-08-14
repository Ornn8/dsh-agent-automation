import assert from 'node:assert/strict'
import test from 'node:test'

import {
  automaticRepairAttemptCount,
  automaticRepairLimitReached,
  MAX_AUTOMATIC_REPAIR_ATTEMPTS,
  recordedRepairStatus,
} from '../src/repair-state.mjs'

const controllerSha = 'a'.repeat(40)
const otherControllerSha = 'b'.repeat(40)
const controllerLogin = 'dsh-controller'

function repairStatus({ marker = 'request', sha = controllerSha, repairClass = 'automatic-review', status = 'failed' } = {}) {
  return [
    `<!-- dsh-review-repair:${sha}:${'c'.repeat(40)}:${marker} -->`,
    '### DSH repair',
    '',
    `- Status: **${status}**`,
    `- Controller SHA: \`${sha}\``,
    `- Repair class: \`${repairClass}\``,
  ].join('\n')
}

test('automatic repair count accepts only distinct controller-authored markers at the current SHA', () => {
  const comments = [
    { user: { login: controllerLogin }, body: repairStatus({ marker: 'review-one' }) },
    { user: { login: controllerLogin }, body: repairStatus({ marker: 'ci-two', repairClass: 'automatic-ci', status: 'complete' }) },
    { user: { login: controllerLogin }, body: repairStatus({ marker: 'review-one', status: 'running' }) },
    { user: { login: controllerLogin }, body: repairStatus({ marker: 'manual', repairClass: 'explicit-human' }) },
    { user: { login: controllerLogin }, body: repairStatus({ marker: 'old-controller', sha: otherControllerSha }) },
    { user: { login: 'pr-author' }, body: repairStatus({ marker: 'forged' }) },
    { user: { login: controllerLogin }, body: repairStatus({ marker: 'dead-letter', status: 'dead-letter' }) },
  ]

  assert.equal(automaticRepairAttemptCount(comments, {
    authorLogin: controllerLogin,
    controllerSha,
  }), 2)
})

test('repair status exposes the controller provenance and dead-letter class without consuming an attempt', () => {
  const status = recordedRepairStatus(repairStatus({ marker: 'limit', repairClass: 'automatic-ci', status: 'dead-letter' }))
  assert.deepEqual(status, {
    marker: `<!-- dsh-review-repair:${controllerSha}:${'c'.repeat(40)}:limit -->`,
    controllerSha,
    repairClass: 'automatic-ci',
    status: 'dead-letter',
    runId: null,
  })
  assert.equal(MAX_AUTOMATIC_REPAIR_ATTEMPTS, 6)
  assert.equal(automaticRepairLimitReached(MAX_AUTOMATIC_REPAIR_ATTEMPTS - 1), false)
  assert.equal(automaticRepairLimitReached(MAX_AUTOMATIC_REPAIR_ATTEMPTS), true)
})
