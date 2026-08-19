import assert from 'node:assert/strict'
import test from 'node:test'

import {
  observeReviewInfrastructureFault,
  recordedReviewFailure,
  trustedFaultProjectionRun,
} from '../src/fault-observation.mjs'
import { applyReviewFaultDecision, reviewFaultAuditDecision } from '../src/review-fault-audit.mjs'

const repository = 'owner/product'
const controllerRepository = 'owner/controller'
const controllerSha = 'c'.repeat(40)
const base = 'a'.repeat(40)
const head = 'b'.repeat(40)

function reviewRun(overrides = {}) {
  return {
    id: 81,
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

function successfulReviewCheck(runId = 81, overrides = {}) {
  return {
    id: 701,
    name: 'agent/review',
    app: { id: 15368 },
    status: 'completed',
    conclusion: 'success',
    head_sha: head,
    details_url: `https://github.com/${repository}/actions/runs/${runId}/job/9001`,
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

test('observer records exact-pair review disagreement before routing and creates no fault', async () => {
  const decision = reviewFaultAuditDecision({
    run: reviewRun(),
    jobs: infrastructureJobs,
    repository,
    trust: { controllerRepository, controllerSha },
    current: currentPullRequest,
    checkRuns: [successfulReviewCheck()],
  })
  assert.equal(decision.classification.category, 'review-evidence-disagreement')
  assert.equal(decision.observation, null)

  const effects = []
  const result = await applyReviewFaultDecision(decision, {
    writeAudit(value) { effects.push(['audit', value.category]) },
    async upsertFault() { effects.push(['fault']); return 99 },
  })
  assert.equal(result, null)
  assert.deepEqual(effects, [['audit', 'review-evidence-disagreement']])
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
