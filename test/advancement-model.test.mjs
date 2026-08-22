import assert from 'node:assert/strict'
import test from 'node:test'
import { decidePullRequestAdvancement } from '../src/advancement-policy.mjs'
import { advancementTransitionIdentity, consumePullRequestAdvancement } from '../src/advancement-runtime.mjs'

const sha = letter => letter.repeat(40)
const digest = letter => letter.repeat(64)
const BASE = sha('a')
const OLD_HEAD = sha('b')
const NEW_HEAD = sha('c')

function check(head = OLD_HEAD, overrides = {}) {
  return {
    id: 1, name: 'ci', head_sha: head, status: 'COMPLETED', conclusion: 'SUCCESS', app: { id: 15368 },
    ...overrides,
  }
}

function reviewProof(head = OLD_HEAD) {
  return {
    state: 'completed',
    proof: {
      checkRun: {
        id: 20, name: 'agent/review', head_sha: head, app: { id: 15368 }, status: 'completed', conclusion: 'success',
        external_id: `agent-review-v3:github-pr-cycle:review:${digest('c')}:30:1`,
        details_url: 'https://github.com/owner/repository/actions/runs/30',
      },
      run: {
        id: 30, run_attempt: 1, name: 'Agent PR Review', path: '.github/workflows/agent-review.yml',
        repository: { full_name: 'owner/repository' }, head_repository: { full_name: 'owner/repository' },
        head_sha: head, event: 'pull_request_target', status: 'completed', conclusion: 'success',
        pull_requests: [{ number: 12, base: { sha: BASE }, head: { sha: head } }],
        referenced_workflows: [{ path: `owner/controller/.github/workflows/agent-review.yml@${digest('c').slice(0, 40)}`, sha: digest('c').slice(0, 40) }],
      },
      jobs: [{
        id: 501, run_id: 30, run_attempt: 1, name: 'agent-review / agent/review', status: 'completed', conclusion: 'success',
        steps: [{ number: 1, name: 'Review exact PR head with the configured Agent', status: 'completed', conclusion: 'success' }],
      }],
    },
  }
}

function snapshot(overrides = {}) {
  return {
    repository: 'owner/repository',
    pullRequest: { number: 12, state: 'open', draft: false, baseRefName: 'main' },
    defaultBranch: 'main',
    pair: { base: BASE, head: OLD_HEAD },
    expectedPair: { base: BASE, head: OLD_HEAD },
    mergeability: 'mergeable',
    review: { state: 'missing', proof: null },
    trustedReview: { controllerRepository: 'owner/controller', controllerSha: digest('c').slice(0, 40), workflowPath: '.github/workflows/agent-review.yml' },
    checks: { required: ['ci'], results: [] },
    governor: { repair: 'idle', recovery: 'idle', paused: false },
    workflow: { definitionHash: digest('c'), workflowId: 'github-pr-cycle', stageId: 'review' },
    stateVersion: digest('d'),
    ...overrides,
  }
}

function applyEvent(state, event) {
  const next = structuredClone(state)
  const kind = typeof event === 'string' ? event : event.kind
  const head = typeof event === 'object' && event.head ? event.head : next.pair.head
  if (kind === 'ci.pass') next.checks.results = [check(head)]
  if (kind === 'review.pass') next.review = reviewProof(head)
  if (kind === 'new-head') {
    next.pair.head = NEW_HEAD
    next.expectedPair = { ...next.pair }
    next.checks.results = []
    next.review = { state: 'missing', proof: null }
  }
  if (typeof event === 'object' && event.expectedHead) next.expectedPair.head = event.expectedHead
  return next
}

function assertWaitWake(decision) {
  if (!['wait-review', 'wait-checks'].includes(decision.action)) return
  assert.equal(typeof decision.missingCondition, 'string')
  assert.ok(decision.missingCondition.length > 0)
  assert.ok(Array.isArray(decision.wakeEvents) && decision.wakeEvents.length > 0)
  assert.equal(typeof decision.scheduledReconciliation, 'boolean')
}

async function replayAdvancement(events) {
  let state = snapshot()
  const effects = []
  const evaluations = []
  const claimed = new Set()
  const route = {
    requestReview: () => effects.push('request-review'),
    requestRepair: () => effects.push('request-repair'),
    requestLanding: () => effects.push('request-landing'),
  }
  const journal = {
    claim: value => {
      const identity = advancementTransitionIdentity(value)
      if (claimed.has(identity)) return false
      claimed.add(identity)
      return true
    },
    markApplied: () => undefined,
  }
  const evaluate = async label => {
    const decision = decidePullRequestAdvancement(state)
    assertWaitWake(decision)
    evaluations.push({ label, decision })
    await consumePullRequestAdvancement({
      ...decision,
      repository: state.repository,
      pullRequestNumber: state.pullRequest.number,
    }, route, journal)
  }
  await evaluate('initial')
  for (const event of events) {
    state = applyEvent(state, event)
    if (typeof event !== 'object' || event.wake !== false) await evaluate(typeof event === 'string' ? event : event.kind)
  }
  return { effects, evaluations, state }
}

test('replays CI-first and review-first completion through one landing mutation', async () => {
  for (const events of [['ci.pass', 'review.pass'], ['review.pass', 'ci.pass']]) {
    const result = await replayAdvancement(events)
    assert.equal(result.effects.filter(effect => effect === 'request-landing').length, 1, events.join(' -> '))
    assert.equal(result.evaluations.some(({ label }) => label === 'scheduled.reconciliation'), false)
  }
})

test('duplicate wakes keep one effective mutation and every wait declares a wake source', async () => {
  const result = await replayAdvancement([
    'ci.pass', 'ci.pass', 'review.pass', 'review.pass',
  ])
  assert.deepEqual(result.effects, ['request-review', 'request-landing'])
  assert.equal(result.evaluations.filter(({ decision }) => decision.action === 'request-landing').length, 2)
})

test('scheduled reconciliation recovers one deliberately lost direct wake', async () => {
  const result = await replayAdvancement([
    'review.pass',
    { kind: 'ci.pass', wake: false },
    'scheduled.reconciliation',
  ])
  assert.equal(result.effects.filter(effect => effect === 'request-landing').length, 1)
  assert.equal(result.evaluations.some(({ label }) => label === 'ci.pass'), false)
  assert.equal(result.evaluations.some(({ label }) => label === 'scheduled.reconciliation'), true)
})

test('stale delayed evidence is a no-op after a new head', async () => {
  const result = await replayAdvancement([
    'new-head',
    { kind: 'review.pass', head: OLD_HEAD, expectedHead: OLD_HEAD },
  ])
  const stale = result.evaluations.at(-1).decision
  assert.equal(stale.action, 'stale')
  assert.equal(result.effects.includes('request-landing'), false)
  assert.equal(result.effects.includes('request-repair'), false)
})
