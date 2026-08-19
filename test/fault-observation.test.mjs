import assert from 'node:assert/strict'
import test from 'node:test'

import {
  observeReviewInfrastructureFault,
  recordedReviewFailure,
  trustedFaultProjectionRun,
} from '../src/fault-observation.mjs'
import {
  applyReviewFaultDecision,
  loadReviewFaultAuditDecision,
  reviewFaultAttemptEndpoints,
  reviewFaultAuditDecision,
  verifyReviewFaultAttempt,
} from '../src/review-fault-audit.mjs'
import { reviewCheckIdentity } from '../src/review-check.mjs'
import { faultIdentity } from '../src/fault-record.mjs'
import { workflowFailureSignature } from '../src/failure-classification.mjs'

const repository = 'owner/product'
const controllerRepository = 'owner/controller'
const controllerSha = 'c'.repeat(40)
const base = 'a'.repeat(40)
const head = 'b'.repeat(40)

function reviewRun(overrides = {}) {
  return {
    id: 81,
    run_attempt: 2,
    name: `Agent PR Review #25 ${base}..${head}`,
    display_title: `Agent PR Review #25 ${base}..${head}`,
    status: 'completed',
    conclusion: 'failure',
    event: 'pull_request_target',
    head_sha: head,
    head_repository: { full_name: repository },
    repository: { full_name: repository },
    pull_requests: [{ number: 25, base: { sha: base }, head: { sha: head } }],
    referenced_workflows: [{
      path: `${controllerRepository}/.github/workflows/agent-review.yml@${controllerSha}`,
      sha: controllerSha,
    }],
    ...overrides,
  }
}

const infrastructureJobs = [{
  id: 501,
  name: 'agent-review / agent/review',
  status: 'completed',
  conclusion: 'failure',
  steps: [{ number: 1, name: 'Review exact PR head with the configured Agent', status: 'completed', conclusion: 'failure' }],
}]

const currentPullRequest = {
  number: 25,
  state: 'open',
  draft: false,
  base: { ref: 'main', sha: base },
  head: { sha: head, repo: { full_name: repository } },
}

function successfulReviewCheck(runId = 81, runAttempt = 2, overrides = {}) {
  return {
    id: 701,
    name: 'agent/review',
    app: { id: 15368 },
    status: 'completed',
    conclusion: 'success',
    head_sha: head,
    details_url: `https://github.com/${repository}/actions/runs/${runId}/job/9001`,
    external_id: reviewCheckIdentity({
      workflowId: 'change',
      stageId: 'review',
      definitionHash: 'd'.repeat(64),
      runId,
      runAttempt,
    }),
    ...overrides,
  }
}

test('a trusted exact-pair reviewer infrastructure failure becomes one host fault observation', () => {
  const observation = observeReviewInfrastructureFault({
    run: reviewRun(),
    jobs: infrastructureJobs,
    repository,
    trust: { controllerRepository, controllerSha },
  })

  assert.deepEqual(observation, {
    repository,
    component: 'review-worker',
    operation: 'recover-review',
    failureClass: 'host',
    errorCode: 'review-infrastructure-failure',
    rootRequestIds: ['pull-request-25'],
    sourceRunId: 81,
    subject: { type: 'pull-request', number: 25, base, head },
  })
})

test('an intentional BLOCK and an untrusted review run never become infrastructure faults', () => {
  const blockJobs = [{
    id: 501,
    name: 'agent-review / agent/review',
    status: 'completed',
    conclusion: 'failure',
    steps: [
      { number: 1, name: 'Publish an independent change work request', status: 'completed', conclusion: 'success' },
      { number: 2, name: 'Preserve the blocking review conclusion', status: 'completed', conclusion: 'failure' },
    ],
  }]
  assert.equal(observeReviewInfrastructureFault({
    run: reviewRun(), jobs: blockJobs, repository, trust: { controllerRepository, controllerSha },
  }), null)
  assert.equal(observeReviewInfrastructureFault({
    run: reviewRun({ referenced_workflows: [] }),
    jobs: infrastructureJobs,
    repository,
    trust: { controllerRepository, controllerSha },
  }), null)

  const decision = reviewFaultAuditDecision({
    run: reviewRun(), jobs: blockJobs, repository,
    trust: { controllerRepository, controllerSha }, current: currentPullRequest, checkRuns: [],
  })
  assert.equal(decision.classification.category, 'review')
  assert.equal(decision.observation, null)

  const contradicted = reviewFaultAuditDecision({
    run: reviewRun(), jobs: blockJobs, repository,
    trust: { controllerRepository, controllerSha }, current: currentPullRequest,
    checkRuns: [successfulReviewCheck()],
  })
  assert.equal(contradicted.classification.category, 'review-evidence-disagreement')
  assert.equal(contradicted.observation, null)
})

test('a fault projection is authorized only by the exact hosted observer workflow provenance', () => {
  const projection = {
    repository,
    controllerRepository,
    controllerSha,
  }
  const issue = {
    user: { login: 'github-actions[bot]' },
    repository_url: `https://api.github.com/repos/${repository}`,
  }
  const run = {
    repository: { full_name: repository },
    status: 'completed',
    conclusion: 'success',
    event: 'workflow_run',
    referenced_workflows: [{
      path: `${controllerRepository}/.github/workflows/observe-agent-fault.yml@${controllerSha}`,
      sha: controllerSha,
    }],
  }

  assert.equal(trustedFaultProjectionRun({
    issue, projection, run, trustedControllerRepository: controllerRepository,
  }), true)
  assert.equal(trustedFaultProjectionRun({
    issue,
    projection,
    run: { ...run, referenced_workflows: [{ ...run.referenced_workflows[0], sha: 'd'.repeat(40) }] },
    trustedControllerRepository: controllerRepository,
  }), false)
  assert.equal(trustedFaultProjectionRun({
    issue,
    projection: { ...projection, controllerRepository: 'attacker/controller' },
    run: {
      ...run,
      referenced_workflows: [{
        path: `attacker/controller/.github/workflows/observe-agent-fault.yml@${controllerSha}`,
        sha: controllerSha,
      }],
    },
    trustedControllerRepository: controllerRepository,
  }), false)
})

test('the hosted observer accepts failure identity only from the exact Actions-owned review CheckRun', () => {
  const check = {
    name: 'agent/review',
    app: { id: 15368 },
    status: 'completed',
    conclusion: 'failure',
    details_url: `https://github.com/${repository}/actions/runs/81`,
    output: {
      summary: 'Agent review infrastructure did not return a verdict. Failure class: host. Error code: review-workspace-busy.',
    },
  }
  assert.deepEqual(recordedReviewFailure([check], 81, repository), {
    failureClass: 'host',
    errorCode: 'review-workspace-busy',
  })
  assert.equal(recordedReviewFailure([{ ...check, app: { id: 1 } }], 81, repository), null)
})

test('observer records authoritative review disagreement for every recoverable conclusion before routing', async () => {
  for (const conclusion of ['failure', 'cancelled', 'timed_out', 'startup_failure', 'stale']) {
    const run = reviewRun({ conclusion })
    const jobs = conclusion === 'failure' ? infrastructureJobs : [{
      id: 501, name: 'agent-review / agent/review', status: 'completed', conclusion,
      steps: [{ number: 1, name: 'Review exact PR head with the configured Agent', status: 'completed', conclusion }],
    }]
    const decision = reviewFaultAuditDecision({
      run, jobs, repository,
      trust: { controllerRepository, controllerSha },
      current: currentPullRequest,
      checkRuns: [successfulReviewCheck()],
    })
    assert.equal(decision.classification.category, 'review-evidence-disagreement', conclusion)
    assert.equal(decision.observation, null)

    const effects = []
    const result = await applyReviewFaultDecision(decision, {
      writeAudit(value) { effects.push(['audit', value.category]) },
      async upsertFault() { effects.push(['fault']); return 99 },
    })
    assert.equal(result, null)
    assert.deepEqual(effects, [['audit', 'review-evidence-disagreement']])
  }
})

test('a successful prior attempt cannot suppress a cancelled or timed-out current review attempt', () => {
  for (const conclusion of ['cancelled', 'timed_out']) {
    const run = reviewRun({ conclusion, run_attempt: 2 })
    const jobs = [{
      id: 501,
      name: 'agent-review / agent/review',
      status: 'completed',
      conclusion,
      steps: [{ number: 1, name: 'Review exact PR head with the configured Agent', status: 'completed', conclusion }],
    }]
    const decision = reviewFaultAuditDecision({
      run,
      jobs,
      repository,
      trust: { controllerRepository, controllerSha },
      current: currentPullRequest,
      checkRuns: [successfulReviewCheck(81, 1)],
    })
    assert.notEqual(decision.classification.category, 'review-evidence-disagreement', conclusion)
    assert.ok(decision.observation, conclusion)
  }
})

test('a successful check without an encoded attempt cannot suppress a current review fault', () => {
  const decision = reviewFaultAuditDecision({
    run: reviewRun({ conclusion: 'timed_out', run_attempt: 2 }),
    jobs: [{
      id: 501,
      name: 'agent-review / agent/review',
      status: 'completed',
      conclusion: 'timed_out',
      steps: [{ number: 1, name: 'Review exact PR head with the configured Agent', status: 'completed', conclusion: 'timed_out' }],
    }],
    repository,
    trust: { controllerRepository, controllerSha },
    current: currentPullRequest,
    checkRuns: [{
      ...successfulReviewCheck(),
      external_id: `https://github.com/${repository}/actions/runs/81`,
    }],
  })
  assert.notEqual(decision.classification.category, 'review-evidence-disagreement')
  assert.ok(decision.observation)
})

test('review fault signature is stable when only an unrelated sibling job changes', () => {
  const sibling = conclusion => ({
    id: 502,
    name: 'caller / unrelated',
    status: 'completed',
    conclusion,
    steps: [{ number: 1, name: 'Unrelated caller step', status: 'completed', conclusion }],
  })
  const input = {
    run: reviewRun(),
    repository,
    trust: { controllerRepository, controllerSha },
    current: currentPullRequest,
    checkRuns: [],
  }
  const first = reviewFaultAuditDecision({ ...input, jobs: [...infrastructureJobs, sibling('failure')] })
  const second = reviewFaultAuditDecision({ ...input, jobs: [...infrastructureJobs, sibling('cancelled')] })
  assert.equal(first.failureSignature, second.failureSignature)
  assert.match(first.failureSignature, /^workflow:[0-9a-f]{64}$/)
})

test('review fault identity and signature follow the authoritative review job rather than caller failure', () => {
  const reviewJob = {
    id: 501,
    name: 'agent-review / agent/review',
    status: 'completed',
    conclusion: 'cancelled',
    steps: [{ number: 1, name: 'Review exact PR head with the configured Agent', status: 'completed', conclusion: 'cancelled' }],
  }
  const sibling = {
    id: 502,
    name: 'caller / unrelated',
    status: 'completed',
    conclusion: 'failure',
    steps: [{ number: 1, name: 'Unrelated caller step', status: 'completed', conclusion: 'failure' }],
  }
  const firstRun = reviewRun({ conclusion: 'cancelled' })
  const secondRun = reviewRun({ conclusion: 'failure' })
  const first = reviewFaultAuditDecision({
    run: firstRun,
    jobs: [reviewJob],
    repository,
    trust: { controllerRepository, controllerSha },
    current: currentPullRequest,
    checkRuns: [],
  })
  const second = reviewFaultAuditDecision({
    run: secondRun,
    jobs: [reviewJob, sibling],
    repository,
    trust: { controllerRepository, controllerSha },
    current: currentPullRequest,
    checkRuns: [],
  })
  assert.deepEqual(
    { failureClass: first.observation.failureClass, errorCode: first.observation.errorCode },
    { failureClass: 'transport', errorCode: 'cancelled' },
  )
  assert.equal(faultIdentity(first.observation), faultIdentity(second.observation))
  assert.equal(first.failureSignature, second.failureSignature)
  assert.notEqual(
    workflowFailureSignature(firstRun, [reviewJob]),
    workflowFailureSignature(secondRun, [reviewJob, sibling]),
  )
})

test('review fault source APIs and response validation bind one immutable workflow attempt', () => {
  assert.deepEqual(reviewFaultAttemptEndpoints(repository, 81, 2), {
    run: 'repos/owner/product/actions/runs/81/attempts/2',
    jobs: 'repos/owner/product/actions/runs/81/attempts/2/jobs',
  })
  assert.doesNotThrow(() => verifyReviewFaultAttempt({ id: 81, run_attempt: 2 }, 81, 2))
  assert.throws(() => verifyReviewFaultAttempt({ id: 81, run_attempt: 3 }, 81, 2), /attempt changed/)
  assert.throws(() => reviewFaultAttemptEndpoints(repository, 81, 0), /attempt identity/)
})

test('repository-dispatch review evidence remains unknown without a production trusted subject input', () => {
  const run = reviewRun({
    event: 'repository_dispatch',
    head_sha: base,
    head_branch: 'main',
    pull_requests: [],
  })
  const decision = reviewFaultAuditDecision({
    run,
    jobs: infrastructureJobs,
    repository,
    trust: { controllerRepository, controllerSha },
    current: currentPullRequest,
    checkRuns: [successfulReviewCheck()],
  })
  assert.equal(decision.classification.category, 'unknown')
  assert.equal(decision.observation, null)

  const stale = reviewFaultAuditDecision({
    run,
    jobs: infrastructureJobs,
    repository,
    trust: { controllerRepository, controllerSha },
    current: { ...currentPullRequest, base: { ...currentPullRequest.base, sha: 'd'.repeat(40) } },
    checkRuns: [successfulReviewCheck()],
  })
  assert.equal(stale.classification.category, 'unknown')
  assert.equal(stale.observation, null)

  const missingExpectedSubject = reviewFaultAuditDecision({
    run,
    jobs: infrastructureJobs,
    repository,
    trust: { controllerRepository, controllerSha },
    current: currentPullRequest,
    checkRuns: [successfulReviewCheck()],
  })
  assert.equal(missingExpectedSubject.classification.category, 'unknown')
  assert.equal(missingExpectedSubject.observation, null)
})

test('observer snapshot loader carries a pull-request-target subject into audit and fault decision', async () => {
  const calls = []
  const decision = await loadReviewFaultAuditDecision({
    run: reviewRun(),
    jobs: infrastructureJobs,
    repository,
    trust: { controllerRepository, controllerSha },
    async readPullRequest(number) {
      calls.push(['pull', number])
      return currentPullRequest
    },
    async readCheckRuns(exactHead) {
      calls.push(['checks', exactHead])
      return []
    },
  })
  assert.deepEqual(calls, [['pull', 25], ['checks', head]])
  assert.equal(decision.classification.category, 'ci-environment')
  assert.equal(decision.observation.sourceRunId, 81)
})

test('failed sibling job cannot turn a successful reusable review job into a review-worker fault', () => {
  const jobs = [{
    id: 501,
    name: 'agent-review / agent/review',
    status: 'completed',
    conclusion: 'success',
    steps: [{ number: 1, name: 'Review exact PR head with the configured Agent', status: 'completed', conclusion: 'success' }],
  }, {
    id: 502,
    name: 'caller / unrelated',
    status: 'completed',
    conclusion: 'failure',
    steps: [{ number: 1, name: 'Unrelated caller step', status: 'completed', conclusion: 'failure' }],
  }]
  const decision = reviewFaultAuditDecision({
    run: reviewRun(), jobs, repository,
    trust: { controllerRepository, controllerSha }, current: currentPullRequest,
    checkRuns: [successfulReviewCheck()],
  })
  assert.equal(decision.classification.category, 'unknown')
  assert.equal(decision.observation, null)
})

test('CheckRun summary prose never changes verified review infrastructure classification', () => {
  const decision = reviewFaultAuditDecision({
    run: reviewRun(), jobs: infrastructureJobs, repository,
    trust: { controllerRepository, controllerSha }, current: currentPullRequest,
    checkRuns: [{
      ...successfulReviewCheck(),
      conclusion: 'failure',
      output: { summary: 'Failure class: protocol. Error code: arbitrary-prose.' },
    }],
  })
  assert.equal(decision.classification.category, 'ci-environment')
  assert.equal(decision.observation.failureClass, 'host')
  assert.equal(decision.observation.errorCode, 'review-infrastructure-failure')
})

test('observer emits unknown audit for stale exact pairs without writing a fault', async () => {
  const decision = reviewFaultAuditDecision({
    run: reviewRun(),
    jobs: infrastructureJobs,
    repository,
    trust: { controllerRepository, controllerSha },
    current: { ...currentPullRequest, base: { ...currentPullRequest.base, sha: 'd'.repeat(40) } },
    checkRuns: [],
  })
  assert.equal(decision.classification.category, 'unknown')
  assert.equal(decision.observation, null)

  const effects = []
  await applyReviewFaultDecision(decision, {
    writeAudit(value) { effects.push(['audit', value.category]) },
    async upsertFault() { effects.push(['fault']); return 99 },
  })
  assert.deepEqual(effects, [['audit', 'unknown']])
})

test('observer emits unknown audit for untrusted review provenance without writing a fault', async () => {
  const decision = reviewFaultAuditDecision({
    run: reviewRun({ referenced_workflows: [] }),
    jobs: infrastructureJobs,
    repository,
    trust: { controllerRepository, controllerSha },
    current: currentPullRequest,
    checkRuns: [successfulReviewCheck()],
  })
  assert.equal(decision.classification.category, 'unknown')
  assert.equal(decision.observation, null)

  const effects = []
  await applyReviewFaultDecision(decision, {
    writeAudit(value) { effects.push(['audit', value.category]) },
    async upsertFault() { effects.push(['fault']); return 99 },
  })
  assert.deepEqual(effects, [['audit', 'unknown']])
})

test('observer writes qualified audit before the first fault mutation', async () => {
  const decision = reviewFaultAuditDecision({
    run: reviewRun(), jobs: infrastructureJobs, repository,
    trust: { controllerRepository, controllerSha }, current: currentPullRequest, checkRuns: [],
  })
  assert.equal(decision.classification.category, 'ci-environment')
  assert.ok(decision.observation)
  const effects = []
  const issue = await applyReviewFaultDecision(decision, {
    writeAudit(value) { effects.push(['audit', value.category]) },
    async upsertFault(observation) { effects.push(['fault', observation.sourceRunId]); return 99 },
  })
  assert.equal(issue, 99)
  assert.deepEqual(effects, [['audit', 'ci-environment'], ['fault', 81]])
})
