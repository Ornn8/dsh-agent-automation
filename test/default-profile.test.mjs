import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { parseWorkflowDefinition } from '../src/workflow-definition.mjs'

const profileUrl = new URL('../profiles/github-pr-cycle/profile.json', import.meta.url)

test('the bundled profile provides a product-neutral GitHub pull request cycle', async () => {
  const source = await readFile(profileUrl, 'utf8')
  const profile = JSON.parse(source)

  assert.doesNotThrow(() => parseWorkflowDefinition(profile))
  assert.doesNotMatch(source, /DeepSeek|DSH|Codex|Claude|OpenCode|"model"|github\.com\//i)

  const stages = profile.workflows.default.stages
  assert.deepEqual(stages.map(stage => [stage.id, stage.uses, stage.after]), [
    ['change', 'worker', []],
    ['review', 'worker', ['change']],
    ['checks', 'checks', ['review']],
    ['merge', 'merge', ['checks']],
  ])
  assert.deepEqual(stages[0], {
    id: 'change', uses: 'worker', role: 'change', procedure: 'github-issue-work', after: [],
  })
  assert.deepEqual(stages[1], {
    id: 'review', uses: 'worker', role: 'review', procedure: 'github-pr-review', after: ['change'],
  })
  assert.deepEqual(stages[2], {
    id: 'checks', uses: 'checks', source: 'branch-protection', after: ['review'],
  })
  assert.deepEqual(stages[3], {
    id: 'merge', uses: 'merge', mode: 'auto', strategy: 'squash', deleteBranch: true, after: ['checks'],
  })
  assert.equal(profile.workflows.repair.stages[0].procedure, 'github-pr-repair')
  assert.equal(profile.workflows.repair.stages[0].retry.limit, 6)
})

test('the same definition format expresses single-worker and human/external-check workflows', () => {
  const singleWorker = {
    version: 1,
    profileId: 'single-worker',
    workflows: {
      default: {
        stages: [
          { id: 'deliver', uses: 'worker', role: 'change', procedure: 'github-issue-delivery', after: [] },
          { id: 'checks', uses: 'checks', source: 'branch-protection', after: ['deliver'] },
          { id: 'merge', uses: 'merge', mode: 'auto', strategy: 'merge', deleteBranch: false, after: ['checks'] },
        ],
        coordination: { limit: 2 },
      },
    },
  }
  const humanAndExternalChecks = {
    version: 1,
    profileId: 'human-and-external-checks',
    workflows: {
      default: {
        stages: [
          { id: 'change', uses: 'worker', role: 'change', procedure: 'github-issue-work', after: [] },
          { id: 'approval', uses: 'checks', names: ['human-approval', 'external-policy'], after: ['change'] },
          { id: 'merge', uses: 'merge', mode: 'manual', strategy: 'rebase', deleteBranch: true, after: ['approval'] },
        ],
        coordination: { limit: 1 },
      },
    },
  }

  assert.doesNotThrow(() => parseWorkflowDefinition(singleWorker))
  assert.doesNotThrow(() => parseWorkflowDefinition(humanAndExternalChecks))
})
