import assert from 'node:assert/strict'
import test from 'node:test'
import {
  recordedCiWorkflow,
  recoveryDecision,
  trustedFailedAgentRun,
} from '../src/recovery-policy.mjs'

const repository = 'owner/repository'
const controller = 'Ornn8/dsh-agent-automation'
const sha = 'c'.repeat(40)
const head = 'a'.repeat(40)

test('recovery preserves only one bounded recorded CI workflow name', () => {
  assert.equal(recordedCiWorkflow('- CI workflow: `CI`'), 'CI')
  assert.equal(recordedCiWorkflow('- CI workflow: `CI`\n- CI workflow: `Security`'), null)
  assert.equal(recordedCiWorkflow('- CI workflow: ``'), null)
  assert.equal(recordedCiWorkflow(`- CI workflow: \`${'x'.repeat(101)}\``), null)
})

function run(overrides = {}) {
  return {
    id: 81, name: 'Agent PR Rework', status: 'completed', conclusion: 'failure',
    repository: { full_name: repository },
    referenced_workflows: [{ path: `${controller}/.github/workflows/dsh-repair.yml@${sha}`, sha }],
    ...overrides,
  }
}

test('all GitHub terminal infrastructure failures recover with immutable controller provenance', () => {
  const trust = { controllerRepository: controller, controllerSha: sha }
  assert.equal(trustedFailedAgentRun({ run: run(), repository, trust }), 'pull-request')
  assert.equal(trustedFailedAgentRun({ run: run({ name: 'Agent PR CI Repair' }), repository, trust }), 'pull-request')
  assert.equal(trustedFailedAgentRun({ run: run({ conclusion: 'cancelled' }), repository, trust }), 'pull-request')
  for (const conclusion of ['timed_out', 'startup_failure', 'stale']) {
    assert.equal(trustedFailedAgentRun({ run: run({ conclusion }), repository, trust }), 'pull-request')
  }
  assert.equal(trustedFailedAgentRun({ run: run({
    name: 'Agent Recovery',
    referenced_workflows: [{ path: `${controller}/.github/workflows/recover-backlog.yml@${sha}`, sha }],
  }), repository, trust }), null)
  assert.equal(trustedFailedAgentRun({ run: run({ referenced_workflows: [] }), repository, trust }), null)
  assert.equal(trustedFailedAgentRun({ run: run({ referenced_workflows: [{ path: '.github/workflows/dsh-repair.yml', sha }] }), repository, trust }), null)
  assert.equal(trustedFailedAgentRun({ run: run({ referenced_workflows: [{ path: `${controller}/.github/workflows/dsh-repair.yml@${'d'.repeat(40)}`, sha: 'd'.repeat(40) }] }), repository, trust }), null)
  assert.equal(trustedFailedAgentRun({ run: run({ repository: { full_name: 'other/repo' } }), repository, trust }), null)
})

test('recovery binds the failed run to one current PR head and never trusts labels alone', () => {
  const decision = recoveryDecision({
    run: run(), repository, trust: { controllerRepository: controller, controllerSha: sha },
    subject: { type: 'pull-request', number: 12, head },
    current: { state: 'open', head: { sha: head, repo: { full_name: repository } }, labels: [{ name: 'agent/dsh-failed' }] },
    attempts: [],
  })
  assert.deepEqual(decision, { action: 'retry', attempt: 1, requestId: 'recovery-81-1' })
  assert.equal(recoveryDecision({
    run: run(), repository, trust: { controllerRepository: controller, controllerSha: sha },
    subject: { type: 'pull-request', number: 12, head },
    current: { state: 'open', head: { sha: 'b'.repeat(40), repo: { full_name: repository } }, labels: [{ name: 'agent/dsh-failed' }] },
    attempts: [],
  }).action, 'ignore')
})

test('recovery backs off transport failures and dead-letters auth, quota, or protocol failures', () => {
  const arguments_ = {
    run: run(), repository, trust: { controllerRepository: controller, controllerSha: sha },
    subject: { type: 'pull-request', number: 12, head },
    current: { state: 'open', head: { sha: head, repo: { full_name: repository } } },
  }
  assert.deepEqual(recoveryDecision({ ...arguments_, attempts: [], failureClass: 'transport' }), {
    action: 'retry', attempt: 1, requestId: 'recovery-81-1', delaySeconds: 30,
  })
  assert.deepEqual(recoveryDecision({ ...arguments_, attempts: [{ attempt: 1 }], failureClass: 'transport' }), {
    action: 'retry', attempt: 2, requestId: 'recovery-81-2', delaySeconds: 120,
  })
  assert.deepEqual(recoveryDecision({ ...arguments_, attempts: [], failureClass: 'auth-quota' }), {
    action: 'dead-letter', attempt: 0, reason: 'auth-quota',
  })
  assert.deepEqual(recoveryDecision({ ...arguments_, attempts: [], failureClass: 'protocol' }), {
    action: 'dead-letter', attempt: 0, reason: 'protocol',
  })
})

test('a trusted intentional review BLOCK never schedules a second review, while reviewer infrastructure failure retries its exact pair', () => {
  const base = 'd'.repeat(40)
  const reviewRun = run({
    name: `Agent PR Review #12 ${base}..${head}`,
    display_title: `Agent PR Review #12 ${base}..${head}`,
    path: '.github/workflows/agent-pr-review.yml',
    event: 'pull_request_target',
    head_repository: { full_name: repository },
    head_sha: head,
    pull_requests: [{ number: 12, base: { sha: base }, head: { sha: head } }],
    referenced_workflows: [{ path: `${controller}/.github/workflows/agent-review.yml@${sha}`, sha }],
  })
  const current = { state: 'open', base: { sha: base }, head: { sha: head, repo: { full_name: repository } } }
  const subject = { type: 'pull-request', number: 12, base, head }
  const intentionalBlock = [{
    name: 'agent-review / agent/review', conclusion: 'failure', steps: [
      { name: 'Review exact PR head with Codex', conclusion: 'success' },
      { name: 'Publish an independent change work request', conclusion: 'success' },
      { name: 'Preserve the blocking review conclusion', conclusion: 'failure' },
    ],
  }]
  const reviewerInfrastructureFailure = [{
    name: 'agent-review / agent/review', conclusion: 'failure', steps: [
      { name: 'Review exact PR head with Codex', conclusion: 'failure' },
    ],
  }]
  const arguments_ = {
    run: reviewRun, repository, trust: { controllerRepository: controller, controllerSha: sha }, subject, current, attempts: [],
  }
  assert.deepEqual(recoveryDecision({ ...arguments_, jobs: intentionalBlock }), { action: 'ignore' })
  assert.deepEqual(recoveryDecision({ ...arguments_, jobs: [{ ...intentionalBlock[0], steps: intentionalBlock[0].steps.filter(step => step.name !== 'Publish an independent change work request') }] }), {
    action: 'retry', attempt: 1, requestId: 'recovery-81-1',
  })
  assert.deepEqual(recoveryDecision({ ...arguments_, jobs: [{ ...intentionalBlock[0], steps: intentionalBlock[0].steps.map(step => step.name === 'Publish an independent change work request'
    ? { ...step, conclusion: 'failure' } : step) }] }), {
    action: 'retry', attempt: 1, requestId: 'recovery-81-1',
  })
  assert.deepEqual(recoveryDecision({ ...arguments_, jobs: reviewerInfrastructureFailure }), {
    action: 'retry', attempt: 1, requestId: 'recovery-81-1',
  })
  assert.deepEqual(recoveryDecision({
    ...arguments_,
    jobs: reviewerInfrastructureFailure,
    attempts: [{ attempt: 1 }, { attempt: 2 }, { attempt: 3 }],
  }), { action: 'retry', attempt: 4, requestId: 'recovery-81-4' })
  assert.deepEqual(recoveryDecision({
    ...arguments_,
    run: { ...reviewRun, head_repository: { full_name: 'fork/repository' } },
    jobs: reviewerInfrastructureFailure,
  }), { action: 'ignore' })
  assert.deepEqual(recoveryDecision({
    ...arguments_,
    run: { ...reviewRun, head_sha: base },
    jobs: reviewerInfrastructureFailure,
  }), { action: 'ignore' })
  assert.deepEqual(recoveryDecision({
    ...arguments_,
    jobs: [{ ...intentionalBlock[0], name: 'untrusted caller job' }],
  }), { action: 'retry', attempt: 1, requestId: 'recovery-81-1' })
})

test('review recovery accepts a pinned repository dispatch run from the default branch', () => {
  const base = 'd'.repeat(40)
  const reviewRun = run({
    name: 'Agent PR Review',
    event: 'repository_dispatch',
    head_repository: { full_name: repository },
    head_sha: base,
    pull_requests: [],
    referenced_workflows: [{ path: `${controller}/.github/workflows/agent-review.yml@${sha}`, sha }],
  })
  assert.equal(trustedFailedAgentRun({
    run: reviewRun,
    repository,
    trust: { controllerRepository: controller, controllerSha: sha },
  }), 'review')
})
