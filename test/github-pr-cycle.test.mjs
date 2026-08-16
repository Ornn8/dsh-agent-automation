import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveGithubPrCycle } from '../src/github-pr-cycle.mjs'
import { loadWorkflowProfile } from '../src/workflow-profile.mjs'

const { definition } = await loadWorkflowProfile()

test('the GitHub PR cycle Adapter resolves both bundled workflows from generic Stages', () => {
  assert.deepEqual(
    Object.values(resolveGithubPrCycle(definition, 'default')).slice(1).map(stage => stage.id),
    ['change', 'review', 'checks', 'merge'],
  )
  assert.equal(resolveGithubPrCycle(definition, 'repair').change.procedure, 'github-pr-repair')
})

test('the GitHub PR cycle Adapter rejects a different graph instead of ignoring its edges', () => {
  const changed = structuredClone(definition)
  changed.workflows.default.stages.find(stage => stage.id === 'merge').after = ['review']
  assert.throws(() => resolveGithubPrCycle(changed, 'default'), /change -> review -> checks -> merge/)
})
