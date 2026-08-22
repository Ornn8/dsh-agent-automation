import assert from 'node:assert/strict'
import test from 'node:test'
import { advancementGovernorState } from '../src/advancement-state.mjs'
import { decidePullRequestAdvancement } from '../src/advancement-policy.mjs'
import {
  advancementRepairCandidate,
  advancementTransitionIdentity,
  consumePullRequestAdvancement,
} from '../src/advancement-runtime.mjs'
import { governorBudgetDecision, governorDecision, subjectStateVersion } from '../src/governor-policy.mjs'
import { pullRequestGovernorSubject } from '../src/governor-state.mjs'

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

function reviewProof(head = OLD_HEAD, kind = 'pass') {
  const runConclusion = kind === 'pass' ? 'success' : kind === 'block' ? 'failure' : 'cancelled'
  const jobConclusion = kind === 'pass' ? 'success' : kind === 'block' ? 'failure' : 'cancelled'
  const steps = kind === 'block'
    ? [
        { number: 1, name: 'Publish an independent change work request', status: 'completed', conclusion: 'success' },
        { number: 2, name: 'Preserve the blocking review conclusion', status: 'completed', conclusion: 'failure' },
      ]
    : [{ number: 1, name: 'Review exact PR head with the configured Agent', status: 'completed', conclusion: jobConclusion }]
  return {
    state: 'completed',
    proof: {
      checkRun: {
        id: 20, name: 'agent/review', head_sha: head, app: { id: 15368 }, status: 'completed',
        conclusion: kind === 'pass' ? 'success' : 'failure',
        external_id: `agent-review-v3:github-pr-cycle:review:${digest('c')}:30:1`,
        details_url: 'https://github.com/owner/repository/actions/runs/30',
      },
      run: {
        id: 30, run_attempt: 1, name: 'Agent PR Review', path: '.github/workflows/agent-review.yml',
        repository: { full_name: 'owner/repository' }, head_repository: { full_name: 'owner/repository' },
        head_sha: head, event: 'pull_request_target', status: 'completed', conclusion: runConclusion,
        pull_requests: [{ number: 12, base: { sha: BASE }, head: { sha: head } }],
        referenced_workflows: [{ path: `owner/controller/.github/workflows/agent-review.yml@${digest('c').slice(0, 40)}`, sha: digest('c').slice(0, 40) }],
      },
      jobs: [{
        id: 501, run_id: 30, run_attempt: 1, name: 'agent-review / agent/review', status: 'completed', conclusion: jobConclusion,
        steps,
      }],
    },
  }
}

function governorSubject(state) {
  return {
    type: 'pull-request',
    number: state.pullRequest.number,
    state: state.pullRequest.state,
    draft: state.pullRequest.draft,
    base: state.pair.base,
    head: state.pair.head,
    labels: [],
  }
}

function syncGovernorState(state, records) {
  state.stateVersion = subjectStateVersion(governorSubject(state))
  state.governor = advancementGovernorState(records, state.pullRequest.number, state.stateVersion)
}

function snapshot(overrides = {}) {
  const value = {
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
  value.stateVersion = subjectStateVersion(governorSubject(value))
  return value
}

function applyEvent(state, event, records) {
  const next = structuredClone(state)
  const kind = typeof event === 'string' ? event : event.kind
  const head = typeof event === 'object' && event.head ? event.head : next.pair.head
  let beforeHeadGovernor = null
  let beforeHeadPair = null
  if (kind === 'ci.pass') next.checks.results = [check(head)]
  if (kind === 'review.pass') next.review = reviewProof(head, 'pass')
  if (kind === 'review.block') next.review = reviewProof(head, 'block')
  if (kind === 'review.infrastructure') next.review = reviewProof(head, 'infrastructure')
  if (kind === 'review.recovery.completed') next.review = { state: 'missing', proof: null }
  if (kind === 'new-head' || kind === 'repair.completed') {
    if (kind === 'repair.completed') {
      const repair = records.find(record => record.status === 'candidate' && record.transition?.startsWith('review-repair:'))
      assert.ok(repair, 'repair completion must follow a bounded review repair candidate')
      records.push({ ...repair, status: 'applied', observationId: 'reconcile-reviews-1' })
      beforeHeadGovernor = advancementGovernorState(records, next.pullRequest.number, next.stateVersion)
      beforeHeadPair = { ...next.pair }
    }
    next.pair.head = NEW_HEAD
    next.expectedPair = { ...next.pair }
    next.checks.results = []
    next.review = { state: 'missing', proof: null }
  }
  if (typeof event === 'object' && event.expectedHead) next.expectedPair.head = event.expectedHead
  syncGovernorState(next, records)
  return { state: next, beforeHeadGovernor, beforeHeadPair }
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
  const records = []
  syncGovernorState(state, records)
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
    evaluations.push({ label, decision, pair: structuredClone(state.pair), governor: structuredClone(state.governor) })
    let request = {
      ...decision,
      repository: state.repository,
      pullRequestNumber: state.pullRequest.number,
    }
    if (request.action === 'request-repair' && !request.repair?.candidate) {
      const repair = advancementRepairCandidate({
        records,
        subject: pullRequestGovernorSubject({
          number: state.pullRequest.number,
          state: state.pullRequest.state,
          draft: state.pullRequest.draft,
          base: { sha: state.pair.base },
          head: { sha: state.pair.head },
          labels: [],
        }),
        stateVersion: state.stateVersion,
        transitionIdentity: advancementTransitionIdentity(request),
        repairCause: request.repair?.cause,
      })
      assert.ok(repair.record, 'repair request must persist one bounded candidate')
      records.push(repair.record)
      request = {
        ...request,
        repair: { ...request.repair, candidate: { transition: repair.transition, observationId: repair.record.observationId } },
      }
      syncGovernorState(state, records)
    }
    await consumePullRequestAdvancement(request, route, journal)
  }
  await evaluate('initial')
  const transitionProjections = []
  for (const event of events) {
    const applied = applyEvent(state, event, records)
    state = applied.state
    if (applied.beforeHeadGovernor) {
      transitionProjections.push({
        event: typeof event === 'string' ? event : event.kind,
        pair: applied.beforeHeadPair,
        governor: applied.beforeHeadGovernor,
      })
    }
    if (typeof event !== 'object' || event.wake !== false) await evaluate(typeof event === 'string' ? event : event.kind)
  }
  return { effects, evaluations, state, records, transitionProjections }
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

test('replays a bounded review repair and ignores old-pair evidence before landing the new pair', async () => {
  const result = await replayAdvancement([
    'review.block',
    'repair.completed',
    { kind: 'review.pass', head: OLD_HEAD },
    { kind: 'ci.pass', head: OLD_HEAD },
    { kind: 'review.pass', head: NEW_HEAD },
    { kind: 'ci.pass', head: NEW_HEAD },
  ])
  assert.equal(result.state.pair.head, NEW_HEAD)
  assert.equal(result.effects.filter(effect => effect === 'request-repair').length, 1)
  assert.equal(result.effects.filter(effect => effect === 'request-landing').length, 1)
  assert.equal(result.records.length, 2)
  assert.equal(result.records[0].status, 'candidate')
  assert.equal(result.records[1].status, 'applied')
  assert.notEqual(result.records[0], result.records[1])
  assert.equal(result.records[0].transition, result.records[1].transition)
  assert.deepEqual(result.records[0].subject, result.records[1].subject)
  assert.equal(result.records[0].stateVersion, result.records[1].stateVersion)
  assert.match(result.records[0].transition, /^review-repair:/)
  assert.deepEqual(result.transitionProjections, [{
    event: 'repair.completed',
    pair: { base: BASE, head: OLD_HEAD },
    governor: { repair: 'running', repairCandidate: null, recovery: 'idle', paused: false },
  }])
  assert.equal(result.evaluations[2].pair.head, NEW_HEAD)
  assert.equal(result.evaluations[2].governor.repair, 'idle')
  assert.equal(result.evaluations[3].decision.action, 'wait-review')
  assert.equal(result.evaluations[4].decision.action, 'wait-review')
  assert.equal(result.evaluations[5].decision.action, 'wait-checks')
  assert.equal(result.evaluations[6].decision.action, 'request-landing')
})

test('routes a review infrastructure failure through recovery before exact-pair landing', async () => {
  const result = await replayAdvancement([
    'ci.pass',
    'review.infrastructure',
    'review.recovery.completed',
    'review.pass',
    'ci.pass',
  ])
  assert.equal(result.effects.includes('request-repair'), false)
  assert.deepEqual(result.effects, ['request-review', 'request-landing'])
  assert.equal(result.evaluations[2].decision.action, 'wait-review')
  assert.equal(result.evaluations[2].decision.missingCondition, 'review-infrastructure-recovery')
  assert.equal(result.evaluations.at(-1).decision.action, 'request-landing')
})

test('replays pause and resume while keeping review and CI budgets independent', () => {
  const subject = {
    type: 'pull-request', number: 12, state: 'open', draft: false,
    base: BASE, head: OLD_HEAD, labels: [],
  }
  const stateVersion = subjectStateVersion(subject)
  const records = []
  const record = decision => {
    assert.equal(decision.execute, true)
    records.push(decision.record)
  }
  record(governorBudgetDecision({
    transition: 'review-repair', subject, workIdentity: 'branch:agent/fix', observationId: 'review-1', limit: 1, records,
  }))
  record(governorBudgetDecision({
    transition: 'ci-repair', subject, workIdentity: 'branch:agent/fix', observationId: 'ci-1', limit: 2, records,
  }))
  const pause = governorBudgetDecision({
    transition: 'review-repair', subject, workIdentity: 'branch:agent/fix', observationId: 'review-2', limit: 1, records,
  })
  assert.equal(pause.action, 'pause')
  records.push(pause.record)
  assert.equal(advancementGovernorState(records, subject.number, stateVersion).paused, true)

  const resume = governorDecision({
    transition: 'review-repair', subject, stateVersion, observationId: 'resume-1', records,
    resumeCondition: { authorized: true, commandId: 'command-1' },
  })
  assert.equal(resume.action, 'record-resume')
  records.push(resume.record)
  assert.equal(advancementGovernorState(records, subject.number, stateVersion).paused, false)
  const afterResume = governorBudgetDecision({
    transition: 'review-repair', subject, workIdentity: 'branch:agent/fix', observationId: 'review-3', limit: 1, records,
  })
  assert.equal(afterResume.action, 'attempt')
  assert.equal(afterResume.record.attempt, 1)
})
