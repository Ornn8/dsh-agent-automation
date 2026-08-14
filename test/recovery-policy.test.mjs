import assert from 'node:assert/strict'
import test from 'node:test'
import {
  MAX_RECOVERY_ATTEMPTS,
  recoveryDecision,
  recoveryMarkerBody,
  trustedFailedAgentRun,
} from '../src/recovery-policy.mjs'

const repository = 'owner/repository'
const controller = 'Ornn8/dsh-agent-automation'
const sha = 'c'.repeat(40)
const head = 'a'.repeat(40)

function run(overrides = {}) {
  return {
    id: 81, name: 'Agent PR Rework', status: 'completed', conclusion: 'failure',
    repository: { full_name: repository },
    referenced_workflows: [{ path: `${controller}/.github/workflows/dsh-repair.yml@${sha}`, sha }],
    ...overrides,
  }
}

test('only a failed or cancelled top-level agent run with immutable controller provenance can recover', () => {
  const trust = { controllerRepository: controller, controllerSha: sha }
  assert.equal(trustedFailedAgentRun({ run: run(), repository, trust }), 'pull-request')
  assert.equal(trustedFailedAgentRun({ run: run({ conclusion: 'cancelled' }), repository, trust }), 'pull-request')
  assert.equal(trustedFailedAgentRun({ run: run({ name: 'Agent Recovery' }), repository, trust }), null)
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

test('recovery caps exact subjects at three durable attempts without recursive model calls', () => {
  const attempts = Array.from({ length: MAX_RECOVERY_ATTEMPTS }, (_, index) => ({ attempt: index + 1 }))
  const decision = recoveryDecision({
    run: run({ name: 'Agent Issues', referenced_workflows: [{ path: `${controller}/.github/workflows/dsh-issue.yml@${sha}`, sha }] }), repository, trust: { controllerRepository: controller, controllerSha: sha },
    subject: { type: 'issue', number: 7 },
    current: { state: 'open', labels: [{ name: 'agent/dsh-failed' }] }, attempts,
  })
  assert.deepEqual(decision, { action: 'dead-letter', attempt: 3 })
  assert.match(recoveryMarkerBody({ type: 'issue', number: 7 }, 3, 81, 'dead-letter', repository), /Status: \*\*dead-letter\*\*/)
})

test('a trusted intentional review BLOCK never schedules a second review, while reviewer infrastructure failure retries its exact pair', () => {
  const base = 'd'.repeat(40)
  const reviewRun = run({
    name: 'Agent PR Review',
    event: 'pull_request_target',
    head_repository: { full_name: repository },
    head_sha: base,
    pull_requests: [{ number: 12, base: { sha: base }, head: { sha: head } }],
    referenced_workflows: [{ path: `${controller}/.github/workflows/codex-review.yml@${sha}`, sha }],
  })
  const current = { state: 'open', base: { sha: base }, head: { sha: head, repo: { full_name: repository } } }
  const subject = { type: 'pull-request', number: 12, base, head }
  const intentionalBlock = [{
    name: 'codex-review / codex/review', conclusion: 'failure', steps: [
      { name: 'Review exact PR head with Codex', conclusion: 'success' },
      { name: 'Publish an independent change work request', conclusion: 'success' },
      { name: 'Preserve the blocking review conclusion', conclusion: 'failure' },
    ],
  }]
  const reviewerInfrastructureFailure = [{
    name: 'codex-review / codex/review', conclusion: 'failure', steps: [
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
  }), { action: 'dead-letter', attempt: 3 })
  assert.deepEqual(recoveryDecision({
    ...arguments_,
    run: { ...reviewRun, head_repository: { full_name: 'fork/repository' } },
    jobs: reviewerInfrastructureFailure,
  }), { action: 'ignore' })
  assert.deepEqual(recoveryDecision({
    ...arguments_,
    run: { ...reviewRun, head_sha: head },
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
    referenced_workflows: [{ path: `${controller}/.github/workflows/codex-review.yml@${sha}`, sha }],
  })
  assert.equal(trustedFailedAgentRun({
    run: reviewRun,
    repository,
    trust: { controllerRepository: controller, controllerSha: sha },
  }), 'review')
})
