import assert from 'node:assert/strict'
import test from 'node:test'
import { decidePullRequestAdvancement } from '../src/advancement-policy.mjs'

const sha = letter => letter.repeat(40)
const digest = letter => letter.repeat(64)

function check(overrides = {}) {
  return {
    id: 1,
    name: 'ci',
    head_sha: sha('b'),
    status: 'COMPLETED',
    conclusion: 'SUCCESS',
    app: { id: 15368 },
    ...overrides,
  }
}

function reviewEvidence(kind = 'pass', overrides = {}) {
  const runConclusion = kind === 'pass' ? 'success' : kind === 'block' ? 'failure' : 'cancelled'
  const jobConclusion = kind === 'pass' ? 'success' : kind === 'block' ? 'failure' : 'cancelled'
  const steps = kind === 'block'
    ? [
        { number: 1, name: 'Publish an independent change work request', status: 'completed', conclusion: 'success' },
        { number: 2, name: 'Preserve the blocking review conclusion', status: 'completed', conclusion: 'failure' },
      ]
    : [{ number: 1, name: 'Review exact PR head with the configured Agent', status: 'completed', conclusion: jobConclusion }]
  const proof = {
    checkRun: {
      id: 20,
      name: 'agent/review',
      head_sha: sha('b'),
      app: { id: 15368 },
      status: 'completed',
      conclusion: kind === 'pass' ? 'success' : 'failure',
      external_id: `agent-review-v3:github-pr-cycle:review:${digest('c')}:30:1`,
      details_url: 'https://github.com/owner/repository/actions/runs/30',
    },
    run: {
      id: 30,
      run_attempt: 1,
      name: 'Agent PR Review',
      path: '.github/workflows/agent-review.yml',
      repository: { full_name: 'owner/repository' },
      head_repository: { full_name: 'owner/repository' },
      head_sha: sha('b'),
      event: 'pull_request_target',
      status: 'completed',
      conclusion: runConclusion,
      pull_requests: [{ number: 12, base: { sha: sha('a') }, head: { sha: sha('b') } }],
      referenced_workflows: [{ path: `owner/controller/.github/workflows/agent-review.yml@${sha('c')}`, sha: sha('c') }],
    },
    jobs: [{ id: 501, run_id: 30, run_attempt: 1, name: 'agent-review / agent/review', status: 'completed', conclusion: jobConclusion, steps }],
    ...overrides,
  }
  return { state: 'completed', proof }
}

function snapshot(overrides = {}) {
  return {
    repository: 'owner/repository',
    pullRequest: { number: 12, state: 'open', draft: false, baseRefName: 'main' },
    defaultBranch: 'main',
    pair: { base: sha('a'), head: sha('b') },
    expectedPair: { base: sha('a'), head: sha('b') },
    mergeability: 'mergeable',
    review: { state: 'missing' },
    trustedReview: { controllerRepository: 'owner/controller', controllerSha: sha('c'), workflowPath: '.github/workflows/agent-review.yml' },
    checks: { required: ['ci'], results: [] },
    governor: { repair: 'idle', recovery: 'idle', paused: false },
    workflow: { definitionHash: digest('c'), workflowId: 'github-pr-cycle', stageId: 'review' },
    stateVersion: digest('d'),
    ...overrides,
  }
}

const passedCi = { required: ['ci'], results: [check()] }
const passedReview = reviewEvidence('pass')

test('CI success with no trusted review waits for the exact-pair review completion', () => {
  assert.deepEqual(decidePullRequestAdvancement(snapshot({ checks: passedCi })), {
    action: 'wait-review',
    reason: 'trusted exact-pair review is missing',
    missingCondition: 'trusted-exact-pair-review',
    wakeEvents: ['review.completed'],
    scheduledReconciliation: true,
    pair: { base: sha('a'), head: sha('b') },
    stateVersion: digest('d'),
    workflow: { definitionHash: digest('c'), workflowId: 'github-pr-cycle', stageId: 'review' },
  })
})

test('no CI and no review requests a review', () => {
  assert.equal(decidePullRequestAdvancement(snapshot()).action, 'request-review')
})

test('review-first completion waits for the exact-head CI result', () => {
  const decision = decidePullRequestAdvancement(snapshot({ review: passedReview }))
  assert.equal(decision.action, 'wait-checks')
  assert.equal(decision.missingCondition, 'required-exact-head-checks')
  assert.deepEqual(decision.wakeEvents, ['ci.required-check.completed'])
})

test('trusted exact-pair review and required checks request landing', () => {
  assert.equal(decidePullRequestAdvancement(snapshot({ review: passedReview, checks: passedCi })).action, 'request-landing')
})

test('controller-verified intentional review BLOCK requests repair', () => {
  assert.equal(decidePullRequestAdvancement(snapshot({ review: reviewEvidence('block'), checks: passedCi })).action, 'request-repair')
})

test('controller-verified review infrastructure failure waits for recovery', () => {
  const decision = decidePullRequestAdvancement(snapshot({ review: reviewEvidence('infrastructure') }))
  assert.equal(decision.action, 'wait-review')
  assert.equal(decision.missingCondition, 'review-infrastructure-recovery')
  assert.deepEqual(decision.wakeEvents, ['review.recovery.completed'])
})

test('caller state cannot forge PASS or BLOCK authority', () => {
  for (const state of ['pass', 'block', 'infrastructure-failure']) {
    assert.throws(() => decidePullRequestAdvancement(snapshot({ review: { state } })), /review state is invalid/)
  }
})

test('review evidence from an untrusted controller cannot request repair or landing', () => {
  const review = reviewEvidence('block')
  review.proof.run.referenced_workflows = [{ path: `attacker/controller/.github/workflows/agent-review.yml@${sha('c')}`, sha: sha('c') }]
  const decision = decidePullRequestAdvancement(snapshot({ review, checks: passedCi }))
  assert.equal(decision.action, 'wait-review')
})

test('review evidence for another exact pair cannot request repair or landing', () => {
  const review = reviewEvidence('block')
  review.proof.checkRun.head_sha = sha('f')
  review.proof.run.head_sha = sha('f')
  review.proof.run.pull_requests = [{ number: 12, base: { sha: sha('e') }, head: { sha: sha('f') } }]
  const decision = decidePullRequestAdvancement(snapshot({ review, checks: passedCi }))
  assert.equal(decision.action, 'wait-review')
})

test('review proof must bind the Workflow Definition and exact run attempt', () => {
  const wrongDefinition = reviewEvidence('pass')
  wrongDefinition.proof.checkRun.external_id = `agent-review-v3:github-pr-cycle:review:${digest('e')}:30:1`
  assert.equal(decidePullRequestAdvancement(snapshot({ review: wrongDefinition, checks: passedCi })).action, 'wait-review')

  const wrongAttempt = reviewEvidence('pass')
  wrongAttempt.proof.run.run_attempt = 2
  assert.equal(decidePullRequestAdvancement(snapshot({ review: wrongAttempt, checks: passedCi })).action, 'wait-review')
})

test('every review job must identify the exact selected workflow attempt', () => {
  for (const alteration of [
    job => { delete job.run_id },
    job => { job.run_id = 31 },
    job => { delete job.run_attempt },
    job => { job.run_attempt = 2 },
    job => { job.run_attempt = 0 },
  ]) {
    const review = reviewEvidence('block')
    alteration(review.proof.jobs[0])
    assert.throws(
      () => decidePullRequestAdvancement(snapshot({ review, checks: passedCi })),
      /job attempt changed/,
    )
  }
})

test('a prior-attempt BLOCK or cancellation cannot influence the current attempt', () => {
  for (const kind of ['block', 'infrastructure']) {
    const review = reviewEvidence(kind)
    review.proof.run.run_attempt = 2
    review.proof.checkRun.external_id = `agent-review-v3:github-pr-cycle:review:${digest('c')}:30:2`
    assert.throws(
      () => decidePullRequestAdvancement(snapshot({ review, checks: passedCi })),
      /job attempt changed/,
    )
  }
})

test('failed required CI requests repair after an authoritative review', () => {
  const checks = { required: ['ci'], results: [check({ conclusion: 'FAILURE' })] }
  assert.equal(decidePullRequestAdvancement(snapshot({ review: passedReview, checks })).action, 'request-repair')
})

test('head or base mismatch is stale before evidence evaluation', () => {
  const decision = decidePullRequestAdvancement(snapshot({
    review: passedReview,
    checks: passedCi,
    expectedPair: { base: sha('e'), head: sha('f') },
  }))
  assert.equal(decision.action, 'stale')
  assert.deepEqual(decision.expectedPair, { base: sha('e'), head: sha('f') })
})

test('closed, draft, and paused subjects cannot mutate', () => {
  assert.equal(decidePullRequestAdvancement(snapshot({ pullRequest: { number: 12, state: 'closed', draft: false, baseRefName: 'main' } })).action, 'terminal')
  assert.equal(decidePullRequestAdvancement(snapshot({ pullRequest: { number: 12, state: 'open', draft: true, baseRefName: 'main' } })).action, 'terminal')
  assert.equal(decidePullRequestAdvancement(snapshot({ governor: { repair: 'idle', recovery: 'idle', paused: true } })).action, 'paused')
})

test('duplicate snapshots produce the same decision', () => {
  const value = snapshot({ review: passedReview, checks: passedCi })
  assert.deepEqual(decidePullRequestAdvancement(value), decidePullRequestAdvancement(structuredClone(value)))
})

test('unresolved mergeability has a deterministic wake source', () => {
  const decision = decidePullRequestAdvancement(snapshot({ review: passedReview, checks: passedCi, mergeability: 'unknown' }))
  assert.equal(decision.action, 'wait-checks')
  assert.equal(decision.missingCondition, 'resolved-mergeability')
  assert.deepEqual(decision.wakeEvents, ['pull-request.updated'])
})

test('active and failed Governor work has closed semantics', () => {
  assert.deepEqual(decidePullRequestAdvancement(snapshot({ governor: { repair: 'running', recovery: 'idle', paused: false } })).wakeEvents, ['repair.completed'])
  assert.deepEqual(decidePullRequestAdvancement(snapshot({ governor: { repair: 'idle', recovery: 'running', paused: false } })).wakeEvents, ['recovery.completed'])
  assert.equal(decidePullRequestAdvancement(snapshot({ governor: { repair: 'completed', recovery: 'idle', paused: false } })).action, 'request-review')
  assert.equal(decidePullRequestAdvancement(snapshot({ governor: { repair: 'failed', recovery: 'idle', paused: false } })).action, 'paused')
})

test('pull request base branch must equal the declared default branch', () => {
  assert.throws(() => decidePullRequestAdvancement(snapshot({ pullRequest: { number: 12, state: 'open', draft: false, baseRefName: 'develop' } })), /baseRefName must equal defaultBranch/)
})

test('old exact-head check results do not satisfy the current pair', () => {
  const decision = decidePullRequestAdvancement(snapshot({ checks: { required: ['ci'], results: [check({ head_sha: sha('e') })] } }))
  assert.equal(decision.action, 'request-review')
})

test('required check ordering uses the highest CheckRun id rather than array order', () => {
  const results = [check({ id: 2, conclusion: 'FAILURE' }), check({ id: 1, conclusion: 'SUCCESS' })]
  const checks = { required: ['ci'], results }
  assert.equal(decidePullRequestAdvancement(snapshot({ review: passedReview, checks })).action, 'request-repair')
  assert.equal(decidePullRequestAdvancement(snapshot({ review: passedReview, checks: { ...checks, results: [...results].reverse() } })).action, 'request-repair')
})

test('a newer pending check blocks an older success and an older pending cannot mask a newer success', () => {
  const newerPending = [check({ id: 2, status: 'IN_PROGRESS', conclusion: null }), check({ id: 1 })]
  assert.equal(decidePullRequestAdvancement(snapshot({ review: passedReview, checks: { required: ['ci'], results: newerPending } })).action, 'wait-checks')
  const newerSuccess = [check({ id: 1, status: 'IN_PROGRESS', conclusion: null }), check({ id: 2 })]
  assert.equal(decidePullRequestAdvancement(snapshot({ review: passedReview, checks: { required: ['ci'], results: newerSuccess } })).action, 'request-landing')
})

test('required app binding rejects a same-name result from another app', () => {
  const checks = { required: [{ context: 'ci', app_id: 42 }], results: [check({ app: { id: 7 } })] }
  assert.equal(decidePullRequestAdvancement(snapshot({ review: passedReview, checks })).action, 'wait-checks')
})

test('duplicate check identities fail closed', () => {
  assert.throws(() => decidePullRequestAdvancement(snapshot({ checks: { required: ['ci'], results: [check(), check()] } })), /unique positive integers/)
})

test('a failed sibling job cannot turn a successful review into BLOCK or infrastructure failure', () => {
  const review = reviewEvidence('pass')
  review.proof.jobs.push({ id: 502, run_id: 30, run_attempt: 1, name: 'sibling', status: 'completed', conclusion: 'failure', steps: [] })
  assert.equal(decidePullRequestAdvancement(snapshot({ review, checks: passedCi })).action, 'request-landing')
})
