import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DEFAULT_PROFILE_ID,
  loadWorkflowProfile,
  loadTrustedWorkflowProfile,
  repositoryProfilePath,
  resolveIssueEntryStage,
  resolveWorkflow,
  resolveWorkflowStage,
} from '../src/workflow-profile.mjs'

test('loads the bundled default Profile with a stable identity', async () => {
  const loaded = await loadWorkflowProfile()
  assert.equal(loaded.definition.profileId, DEFAULT_PROFILE_ID)
  assert.match(loaded.definitionHash, /^[0-9a-f]{64}$/)
  assert.match(loaded.source, /profiles\/github-pr-cycle\/profile\.json$/)
  assert.equal(resolveIssueEntryStage(loaded.definition, 'default').procedure, 'github-issue-work')
})

test('resolves workflows and Stages without accepting unknown names or Adapter kinds', async () => {
  const { definition } = await loadWorkflowProfile()
  assert.equal(resolveWorkflow(definition, 'default').coordination.limit, 1)
  assert.equal(resolveWorkflowStage(definition, 'default', 'review', 'worker').role, 'review')
  assert.throws(() => resolveWorkflow(definition, 'missing'), /does not define workflow/)
  assert.throws(() => resolveWorkflowStage(definition, 'default', 'review', 'merge'), /expected merge/)
})

test('Profile loading rejects directory traversal and profileId mismatch', async () => {
  await assert.rejects(loadWorkflowProfile('../other'), /Profile id/)
  await assert.rejects(loadWorkflowProfile('expected', {
    readText: async () => JSON.stringify({
      version: 1,
      profileId: 'different',
      workflows: {
        default: {
          stages: [{
            id: 'change', uses: 'worker', after: [], role: 'change', procedure: 'github-issue-work',
          }],
          coordination: { limit: 1 },
        },
      },
    }),
  }), /contains profileId different/)
})

test('loads a target Profile only from a fixed path at a full trusted revision', async () => {
  const bundled = await loadWorkflowProfile()
  const calls = []
  const loaded = await loadTrustedWorkflowProfile({
    repository: 'owner/repository',
    revision: 'a'.repeat(40),
    profileId: DEFAULT_PROFILE_ID,
    loadContent: async request => {
      calls.push(request)
      return JSON.stringify(bundled.definition)
    },
  })
  assert.deepEqual(calls, [{
    repository: 'owner/repository',
    revision: 'a'.repeat(40),
    path: repositoryProfilePath(DEFAULT_PROFILE_ID),
  }])
  assert.equal(loaded.definitionHash, bundled.definitionHash)
  await assert.rejects(loadTrustedWorkflowProfile({
    repository: 'owner/repository', revision: 'main', loadContent: async () => '{}',
  }), /full lowercase SHA/)
})
