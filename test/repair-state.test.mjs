import assert from 'node:assert/strict'
import test from 'node:test'

import {
  recordedRepairStatus,
} from '../src/repair-state.mjs'

const controllerSha = 'a'.repeat(40)

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
