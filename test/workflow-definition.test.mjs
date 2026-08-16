import assert from 'node:assert/strict'
import test from 'node:test'
import {
  parseWorkflowDefinition,
  workflowDefinitionHash,
} from '../src/workflow-definition.mjs'

function validDefinition() {
  return {
    version: 1,
    profileId: 'github-pr-cycle',
    workflows: {
      delivery: {
        description: '  Implement, verify, and land a change.  ',
        stages: [
          {
            id: 'land',
            uses: 'merge',
            after: ['verify'],
            mode: 'auto',
            strategy: 'squash',
            deleteBranch: true,
          },
          {
            id: 'implement',
            uses: 'worker',
            after: [],
            role: 'change',
            procedure: ' github-issue-work ',
            retry: { limit: 2, backoffSeconds: [30, 120] },
          },
          {
            id: 'verify',
            uses: 'checks',
            after: ['implement'],
            names: ['unit tests', 'build'],
          },
        ],
        coordination: { limit: 2 },
      },
    },
  }
}

test('normalizes a Profile while preserving only generic Stage Adapter configuration', () => {
  assert.deepEqual(parseWorkflowDefinition(validDefinition()), {
    version: 1,
    profileId: 'github-pr-cycle',
    workflows: {
      delivery: {
        description: 'Implement, verify, and land a change.',
        stages: [
          {
            id: 'implement',
            uses: 'worker',
            after: [],
            retry: { limit: 2, backoffSeconds: [30, 120] },
            role: 'change',
            procedure: 'github-issue-work',
          },
          {
            id: 'land',
            uses: 'merge',
            after: ['verify'],
            mode: 'auto',
            strategy: 'squash',
            deleteBranch: true,
          },
          {
            id: 'verify',
            uses: 'checks',
            after: ['implement'],
            names: ['build', 'unit tests'],
          },
        ],
        coordination: { limit: 2 },
      },
    },
  })
})

test('definitionHash is stable across object, workflow, Stage, dependency, and check order', () => {
  const first = validDefinition()
  first.workflows.audit = {
    coordination: { limit: 1 },
    stages: [{
      id: 'inspect', uses: 'worker', after: [], role: 'review', procedure: 'github-pr-review',
    }],
  }
  const second = {
    workflows: {
      audit: first.workflows.audit,
      delivery: {
        coordination: { limit: 2 },
        stages: [
          first.workflows.delivery.stages[2],
          first.workflows.delivery.stages[1],
          first.workflows.delivery.stages[0],
        ],
        description: first.workflows.delivery.description,
      },
    },
    profileId: first.profileId,
    version: 1,
  }
  second.workflows.delivery.stages[0] = {
    ...second.workflows.delivery.stages[0], names: ['build', 'unit tests'],
  }

  const firstHash = workflowDefinitionHash(first)
  assert.match(firstHash, /^[0-9a-f]{64}$/)
  assert.equal(workflowDefinitionHash(second), firstHash)
  assert.notEqual(workflowDefinitionHash({ ...second, profileId: 'another-profile' }), firstHash)
})

test('rejects unknown or missing fields at every strict object level', () => {
  assert.throws(() => parseWorkflowDefinition({ ...validDefinition(), extra: true }), /unknown field extra/)

  const unknownWorkflow = validDefinition()
  unknownWorkflow.workflows.delivery.trigger = 'issue'
  assert.throws(() => parseWorkflowDefinition(unknownWorkflow), /unknown field trigger/)

  const unknownStage = validDefinition()
  unknownStage.workflows.delivery.stages[1].model = 'provider/model'
  assert.throws(() => parseWorkflowDefinition(unknownStage), /unknown field model/)

  const unknownRetry = validDefinition()
  unknownRetry.workflows.delivery.stages[1].retry.jitter = true
  assert.throws(() => parseWorkflowDefinition(unknownRetry), /unknown field jitter/)

  const missingCoordination = validDefinition()
  delete missingCoordination.workflows.delivery.coordination
  assert.throws(() => parseWorkflowDefinition(missingCoordination), /missing required field coordination/)
})

test('rejects duplicate, missing, self, and cyclic Stage dependencies', () => {
  const duplicate = validDefinition()
  duplicate.workflows.delivery.stages[2].id = 'implement'
  assert.throws(() => parseWorkflowDefinition(duplicate), /Stage ids must be unique/)

  const missing = validDefinition()
  missing.workflows.delivery.stages[2].after = ['does-not-exist']
  assert.throws(() => parseWorkflowDefinition(missing), /references unknown Stage/)

  const self = validDefinition()
  self.workflows.delivery.stages[1].after = ['implement']
  assert.throws(() => parseWorkflowDefinition(self), /cannot depend on itself/)

  const cyclic = validDefinition()
  cyclic.workflows.delivery.stages[1].after = ['land']
  assert.throws(() => parseWorkflowDefinition(cyclic), /must be acyclic/)
})

test('rejects unsupported Stage types and variant fields', () => {
  const unsupported = validDefinition()
  unsupported.workflows.delivery.stages[0].uses = 'shell'
  assert.throws(() => parseWorkflowDefinition(unsupported), /uses is unsupported/)

  const wrongVariant = validDefinition()
  wrongVariant.workflows.delivery.stages[2].role = 'review'
  assert.throws(() => parseWorkflowDefinition(wrongVariant), /unknown field role/)

  const unknownRole = validDefinition()
  unknownRole.workflows.delivery.stages[1].role = 'deploy'
  assert.throws(() => parseWorkflowDefinition(unknownRole), /change or review/)

  const mergeMode = validDefinition()
  mergeMode.workflows.delivery.stages[0].mode = 'always'
  assert.throws(() => parseWorkflowDefinition(mergeMode), /mode must be auto or manual/)
})

test('checks resolve either explicit names or the explicit branch-protection source', () => {
  const sourced = validDefinition()
  const verify = sourced.workflows.delivery.stages[2]
  delete verify.names
  verify.source = 'branch-protection'
  assert.deepEqual(parseWorkflowDefinition(sourced).workflows.delivery.stages[2], {
    id: 'verify',
    uses: 'checks',
    after: ['implement'],
    source: 'branch-protection',
  })

  const both = validDefinition()
  both.workflows.delivery.stages[2].source = 'branch-protection'
  assert.throws(() => parseWorkflowDefinition(both), /exactly one of names or source/)

  const neither = validDefinition()
  delete neither.workflows.delivery.stages[2].names
  assert.throws(() => parseWorkflowDefinition(neither), /exactly one of names or source/)

  const unsupported = validDefinition()
  delete unsupported.workflows.delivery.stages[2].names
  unsupported.workflows.delivery.stages[2].source = 'repository-mapping'
  assert.throws(() => parseWorkflowDefinition(unsupported), /source must be branch-protection/)
})

test('enforces bounded Profile, Stage, coordination, checks, text, and retry values', () => {
  const invalidId = validDefinition()
  invalidId.profileId = 'contains spaces'
  assert.throws(() => parseWorkflowDefinition(invalidId), /profileId/)

  const noWorkflows = validDefinition()
  noWorkflows.workflows = {}
  assert.throws(() => parseWorkflowDefinition(noWorkflows), /from 1 to 32/)

  const noStages = validDefinition()
  noStages.workflows.delivery.stages = []
  assert.throws(() => parseWorkflowDefinition(noStages), /from 1 to 64/)

  const concurrency = validDefinition()
  concurrency.workflows.delivery.coordination.limit = 101
  assert.throws(() => parseWorkflowDefinition(concurrency), /from 1 to 100/)

  const checks = validDefinition()
  checks.workflows.delivery.stages[2].names = ['build', ' build ']
  assert.throws(() => parseWorkflowDefinition(checks), /duplicate check names/)

  const retry = validDefinition()
  retry.workflows.delivery.stages[1].retry = { limit: 2, backoffSeconds: [30] }
  assert.throws(() => parseWorkflowDefinition(retry), /for each retry/)

  const description = validDefinition()
  description.workflows.delivery.description = 'line one\nline two'
  assert.throws(() => parseWorkflowDefinition(description), /one-line text/)
})
