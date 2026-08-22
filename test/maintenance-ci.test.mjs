import assert from 'node:assert/strict'
import test from 'node:test'
import { assessMaintenanceCi, MAINTENANCE_CI_WORKFLOW_PATH } from '../src/maintenance-ci.mjs'

const repository = 'owner/controller'
const base = 'a'.repeat(40)
const head = 'b'.repeat(40)
const pullRequest = {
  number: 12,
  state: 'open',
  base: { sha: base, repo: { full_name: repository } },
  head: { sha: head, repo: { full_name: repository } },
}

function workflowRun(overrides = {}) {
  return {
    id: 42,
    name: 'Controller CI',
    path: MAINTENANCE_CI_WORKFLOW_PATH,
    event: 'pull_request',
    status: 'completed',
    conclusion: 'success',
    head_sha: head,
    repository: { full_name: repository },
    pull_requests: [{ number: 12, base: { sha: base }, head: { sha: head } }],
    ...overrides,
  }
}

function checkRun(overrides = {}) {
  return {
    id: 701,
    name: 'all checks passed',
    status: 'completed',
    conclusion: 'success',
    head_sha: head,
    app: { id: 15368 },
    details_url: `https://github.com/${repository}/actions/runs/42/job/701`,
    ...overrides,
  }
}

function input(overrides = {}) {
  return {
    pull: pullRequest,
    files: [{ filename: 'src/fix.mjs', additions: 1, deletions: 0 }],
    workflowRuns: [workflowRun()],
    checkRuns: [checkRun()],
    repository,
    workflowName: 'Controller CI',
    requiredCheckNames: ['all checks passed'],
    ...overrides,
  }
}

test('maintenance CI accepts only a successful exact Controller workflow run and check', () => {
  const result = assessMaintenanceCi(input())
  assert.equal(result.outcome, 'succeeded')
  assert.equal(result.runId, 42)
})

test('maintenance CI waits when the exact workflow run or check is not complete', () => {
  assert.equal(assessMaintenanceCi(input({ workflowRuns: [] })).outcome, 'waiting')
  assert.equal(assessMaintenanceCi(input({
    workflowRuns: [workflowRun({ status: 'in_progress', conclusion: null })],
  })).outcome, 'waiting')
  assert.equal(assessMaintenanceCi(input({
    checkRuns: [checkRun({ status: 'in_progress', conclusion: null })],
  })).outcome, 'waiting')
})

test('maintenance CI rejects a forged same-name check from the wrong workflow identity', () => {
  const result = assessMaintenanceCi(input({
    workflowRuns: [workflowRun({ path: '.github/workflows/shadow.yml' })],
  }))
  assert.equal(result.outcome, 'failed')
})

test('maintenance CI ignores a newer unrelated workflow before selecting the fixed Controller source', () => {
  const result = assessMaintenanceCi(input({
    workflowRuns: [workflowRun(), workflowRun({
      id: 99,
      name: 'Shadow CI',
      path: '.github/workflows/shadow.yml',
    })],
  }))
  assert.equal(result.outcome, 'succeeded')
  assert.equal(result.runId, 42)
})

test('maintenance CI rejects every mismatched repository, event, PR, base, head, or workflow path', () => {
  const cases = [
    ['closed pull request', { pull: { ...pullRequest, state: 'closed' } }],
    ['repository', { repository: 'attacker/controller' }],
    ['run repository', { workflowRuns: [workflowRun({ repository: { full_name: 'attacker/controller' } })] }],
    ['event', { workflowRuns: [workflowRun({ event: 'pull_request_target' })] }],
    ['workflow name', { workflowRuns: [workflowRun({ name: 'Shadow CI' })] }],
    ['pull request number', { workflowRuns: [workflowRun({ pull_requests: [{ number: 13, base: { sha: base }, head: { sha: head } }] })] }],
    ['base SHA', { workflowRuns: [workflowRun({ pull_requests: [{ number: 12, base: { sha: 'c'.repeat(40) }, head: { sha: head } }] })] }],
    ['head SHA', { workflowRuns: [workflowRun({ head_sha: 'c'.repeat(40), pull_requests: [{ number: 12, base: { sha: base }, head: { sha: 'c'.repeat(40) } }] })] }],
    ['stale check head', { checkRuns: [checkRun({ head_sha: 'c'.repeat(40) })] }],
    ['changed workflow path', { files: [{ filename: MAINTENANCE_CI_WORKFLOW_PATH }] }],
  ]
  for (const [label, overrides] of cases) {
    assert.equal(assessMaintenanceCi(input(overrides)).outcome, 'failed', label)
  }
})

test('maintenance CI rejects failed workflow or check conclusions and only-unbound checks', () => {
  assert.equal(assessMaintenanceCi(input({
    workflowRuns: [workflowRun({ conclusion: 'failure' })],
  })).outcome, 'failed')
  assert.equal(assessMaintenanceCi(input({
    checkRuns: [checkRun({ conclusion: 'failure' })],
  })).outcome, 'failed')
  assert.equal(assessMaintenanceCi(input({
    checkRuns: [checkRun({ details_url: `https://github.com/${repository}/actions/runs/99/job/701` })],
  })).outcome, 'failed')
})

test('maintenance CI does not let a newer unbound CheckRun obscure the exact PR CheckRun', () => {
  assert.equal(assessMaintenanceCi(input({
    checkRuns: [checkRun(), checkRun({ id: 702, details_url: `https://github.com/${repository}/actions/runs/99/job/702` })],
  })).outcome, 'succeeded')
})

test('maintenance CI ignores a later push aggregate for the same head', () => {
  const result = assessMaintenanceCi(input({
    checkRuns: [
      checkRun(),
      checkRun({ id: 703, details_url: `https://github.com/${repository}/actions/runs/43/job/703` }),
    ],
  }))
  assert.equal(result.outcome, 'succeeded')
  assert.equal(result.runId, 42)
})

test('maintenance CI fails closed on duplicate identities within the exact workflow run', () => {
  const result = assessMaintenanceCi(input({
    checkRuns: [checkRun(), checkRun({ id: 701, details_url: `https://github.com/${repository}/actions/runs/42/job/702` })],
  }))
  assert.equal(result.outcome, 'failed')
})
