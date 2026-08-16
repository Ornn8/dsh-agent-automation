import assert from 'node:assert/strict'
import test from 'node:test'
import { loadWorkflowProfile } from '../src/workflow-profile.mjs'
import { eligibleWorkflowStages, requireEligibleWorkflowStage } from '../src/workflow-runtime.mjs'

const { definition } = await loadWorkflowProfile()

test('Stage eligibility follows declared dependencies rather than controller order', () => {
  assert.deepEqual(eligibleWorkflowStages(definition, 'default', []).map(stage => stage.id), ['change'])
  assert.deepEqual(eligibleWorkflowStages(definition, 'default', ['change']).map(stage => stage.id), ['review'])
  assert.deepEqual(
    eligibleWorkflowStages(definition, 'default', ['change', 'review']).map(stage => stage.id),
    ['checks'],
  )
  assert.deepEqual(
    eligibleWorkflowStages(definition, 'default', ['change', 'review', 'checks']).map(stage => stage.id),
    ['merge'],
  )
})

test('execution rejects a Stage before its predecessors have trusted evidence', () => {
  assert.throws(() => requireEligibleWorkflowStage(definition, 'default', 'merge', ['change', 'review']), /not eligible/)
  assert.equal(
    requireEligibleWorkflowStage(definition, 'default', 'merge', ['change', 'review', 'checks']).uses,
    'merge',
  )
  assert.throws(() => eligibleWorkflowStages(definition, 'default', ['unknown']), /unknown Stage/)
})
