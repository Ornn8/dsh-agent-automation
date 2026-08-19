import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { decidePullRequestAdvancement } from '../src/advancement-policy.mjs'
import {
  advancementGovernorState,
  buildPullRequestAdvancementSnapshot,
} from '../src/advancement-state.mjs'
import { loadWorkflowProfile } from '../src/workflow-profile.mjs'

const sha = letter => letter.repeat(40)

function pullRequest(overrides = {}) {
  return {
    number: 12,
    state: 'open',
    draft: false,
    mergeable: true,
    base: { ref: 'main', sha: sha('a') },
    head: { ref: 'change', sha: sha('b'), repo: { full_name: 'owner/repository' } },
    labels: [],
    ...overrides,
  }
}

test('CI-first exact state waits for review and an old event becomes stale', async () => {
  const profile = await loadWorkflowProfile()
  const input = {
    repository: 'owner/repository',
    pullRequest: pullRequest(),
    defaultBranch: 'main',
    expectedPair: { base: sha('a'), head: sha('b') },
    profile,
    requestedWorkflowId: 'default',
    trustedReview: {
      controllerRepository: 'owner/controller',
      controllerSha: sha('c'),
      workflowPath: '.github/workflows/agent-review.yml',
    },
    requiredChecks: ['ci'],
    checkResults: [{ id: 1, name: 'ci', head_sha: sha('b'), status: 'completed', conclusion: 'success', app: { id: 15368 } }],
    governorRecords: [],
    readRun: async () => { throw new Error('no review run expected') },
    readJobs: async () => { throw new Error('no review jobs expected') },
  }
  const snapshot = await buildPullRequestAdvancementSnapshot(input)
  assert.equal(decidePullRequestAdvancement(snapshot).action, 'wait-review')

  const stale = await buildPullRequestAdvancementSnapshot({
    ...input,
    expectedPair: { base: sha('d'), head: sha('e') },
  })
  assert.equal(decidePullRequestAdvancement(stale).action, 'stale')
})

test('Governor projection keeps pending repair distinct and closes an authorized resume epoch', () => {
  const version = 'd'.repeat(64)
  const records = [
    { status: 'candidate', transition: 'review-repair:run-1', stateVersion: version, subject: { type: 'pull-request', number: 12 } },
  ]
  assert.equal(advancementGovernorState(records, 12, version).repair, 'pending')
  const paused = [...records,
    { status: 'paused', transition: 'review-repair', subject: { type: 'pull-request', number: 12 } },
  ]
  assert.equal(advancementGovernorState(paused, 12, version).paused, true)
  const resumed = [...paused,
    { status: 'resumed', transition: 'review-repair', subject: { type: 'pull-request', number: 12 } },
  ]
  assert.deepEqual(advancementGovernorState(resumed, 12, version), { repair: 'idle', recovery: 'idle', paused: false })
})

test('Governor applied and attempt records keep repair and recovery running', () => {
  const version = 'd'.repeat(64)
  const records = [
    { status: 'applied', transition: 'review-repair:run-1', stateVersion: version, subject: { type: 'pull-request', number: 12 } },
    { status: 'attempt', transition: 'workflow-recovery', stateVersion: version, subject: { type: 'pull-request', number: 12 } },
  ]
  assert.deepEqual(advancementGovernorState(records, 12, version), {
    repair: 'running',
    recovery: 'running',
    paused: false,
  })
})

test('a cancelled old-pair review is stale and never enters recovery classification', async () => {
  const profile = await loadWorkflowProfile()
  let readRunCalls = 0
  const snapshot = await buildPullRequestAdvancementSnapshot({
    repository: 'owner/repository',
    pullRequest: pullRequest(),
    defaultBranch: 'main',
    expectedPair: { base: sha('c'), head: sha('d') },
    profile,
    requestedWorkflowId: 'default',
    trustedReview: {
      controllerRepository: 'owner/controller',
      controllerSha: sha('c'),
      workflowPath: '.github/workflows/agent-review.yml',
    },
    requiredChecks: ['ci'],
    checkResults: [{
      id: 9,
      name: 'agent/review',
      head_sha: sha('d'),
      status: 'completed',
      conclusion: 'cancelled',
    }],
    governorRecords: [],
    readRun: async () => { readRunCalls += 1; throw new Error('old review run must not be read') },
    readJobs: async () => { throw new Error('old review jobs must not be read') },
  })
  assert.equal(decidePullRequestAdvancement(snapshot).action, 'stale')
  assert.equal(readRunCalls, 0)
})

test('all direct and scheduled wake sources enter the exact-state advancement path', async () => {
  const targetAdvance = await readFile(new URL('../templates/target/.github/workflows/agent-pr-land.yml', import.meta.url), 'utf8')
  const targetReview = await readFile(new URL('../templates/target/.github/workflows/agent-pr-review.yml', import.meta.url), 'utf8')
  const targetRework = await readFile(new URL('../templates/target/.github/workflows/agent-pr-rework.yml', import.meta.url), 'utf8')
  const wakeRework = await readFile(new URL('../.github/workflows/wake-rework.yml', import.meta.url), 'utf8')
  const review = await readFile(new URL('../.github/workflows/agent-review.yml', import.meta.url), 'utf8')
  const repair = await readFile(new URL('../src/dsh-repair.mjs', import.meta.url), 'utf8')
  const resume = await readFile(new URL('../src/wake-rework.mjs', import.meta.url), 'utf8')
  const reconcile = await readFile(new URL('../src/reconcile-landing.mjs', import.meta.url), 'utf8')
  const reviewReconcile = await readFile(new URL('../src/reconcile-reviews.mjs', import.meta.url), 'utf8')

  assert.match(targetAdvance, /types: \[dsh-land, dsh-advance\]/)
  assert.match(targetAdvance, /workflow_run:/)
  assert.match(targetAdvance, /pull_request_target:/)
  assert.match(targetAdvance, /workflows\/advance-pr\.yml/)
  assert.match(targetAdvance, /DSH_AUTOMATION_REQUIRED_CHECKS/)
  assert.doesNotMatch(targetReview, /pull_request_target:/)
  assert.match(review, /Wake exact-state advancement after review publication/)
  assert.match(repair, /event_type: 'dsh-advance'/)
  assert.match(resume, /event_type: 'dsh-advance'/)
  assert.match(targetRework, /agent-review-reconcile/)
  assert.match(targetRework, /contents: write/)
  assert.match(wakeRework, /contents: write/)
  assert.match(reconcile, /advance-pr\.mjs/)
  assert.doesNotMatch(reconcile, /land-pr\.mjs/)
  assert.match(reviewReconcile, /event_type=dsh-advance/)
  assert.doesNotMatch(reviewReconcile, /event_type=agent-review/)
})
