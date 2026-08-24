import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizePullRequestSubjectSnapshot } from '../src/coordinator-v2/pr-subject-snapshot.mjs'

const repository = 'ornn8/example'
const pullRequestNumber = 7
const baseSha = '1'.repeat(40)
const headSha = '2'.repeat(40)

const pullRequest = overrides => ({
  repository,
  number: pullRequestNumber,
  state: 'open',
  draft: false,
  baseBranch: 'master',
  baseSha,
  headRepository: repository,
  headSha,
  mergeable: true,
  ...overrides,
})

const ciInput = overrides => ({
  headSha,
  requiredChecks: [{ name: 'build', appId: 10 }],
  checkSnapshot: {
    complete: true,
    headSha,
    checkRuns: [{
      id: 1,
      name: 'build',
      appId: 10,
      headSha,
      status: 'completed',
      conclusion: 'success',
    }],
  },
  ...overrides,
})

const linkedIssue = overrides => ({
  repository,
  number: 5,
  state: 'open',
  type: 'issue',
  ...overrides,
})

const input = overrides => ({
  repository,
  pullRequestNumber,
  repositorySnapshot: { repository, defaultBranch: 'master' },
  pullRequestBefore: pullRequest(),
  pullRequestAfter: pullRequest(),
  ciInput: ciInput(),
  linkedIssueSnapshot: { complete: true, issues: [linkedIssue()] },
  repairSnapshot: null,
  ...overrides,
})

test('normalizes one coherent current task pull request snapshot', () => {
  const result = normalizePullRequestSubjectSnapshot(input({
    pullRequestBefore: pullRequest({ mergeable: null }),
    repairSnapshot: { complete: true, active: false, attempts: 1, limit: 3 },
  }))
  assert.equal(result.status, 'ok')
  assert.deepEqual(result.snapshot, {
    repository,
    pullRequestNumber,
    defaultBranch: 'master',
    pullRequest: pullRequest(),
    ci: {
      headSha,
      status: 'passed',
      checks: [{ name: 'build', appId: 10, status: 'passed', checkRunId: 1 }],
    },
    repair: { active: false, attempts: 1, limit: 3 },
    linkedIssue: linkedIssue(),
  })
})

test('detects lifecycle and exact-pair drift while allowing mergeability convergence', () => {
  const drifts = [
    ['state', 'closed'],
    ['draft', true],
    ['baseBranch', 'release'],
    ['baseSha', '3'.repeat(40)],
    ['headRepository', 'ornn8/other'],
    ['headSha', '4'.repeat(40)],
  ]
  for (const [field, value] of drifts) {
    const result = normalizePullRequestSubjectSnapshot(input({
      pullRequestAfter: pullRequest({ [field]: value }),
    }))
    assert.equal(result.status, 'drifted', field)
    assert.deepEqual(result.changedFields, [field], field)
  }

  const mergeabilityOnly = normalizePullRequestSubjectSnapshot(input({
    pullRequestBefore: pullRequest({ mergeable: null }),
    pullRequestAfter: pullRequest({ mergeable: false }),
  }))
  assert.equal(mergeabilityOnly.status, 'ok')
  assert.equal(mergeabilityOnly.snapshot.pullRequest.mergeable, false)
})

test('classifies ordinary non-automated pull request subjects as ineligible', () => {
  const cases = [
    [input({ pullRequestBefore: pullRequest({ state: 'closed' }), pullRequestAfter: pullRequest({ state: 'closed' }) }), 'pull-request-not-open'],
    [input({ pullRequestBefore: pullRequest({ draft: true }), pullRequestAfter: pullRequest({ draft: true }) }), 'draft'],
    [input({ repositorySnapshot: { repository, defaultBranch: 'main' } }), 'wrong-target-branch'],
    [input({ pullRequestBefore: pullRequest({ headRepository: 'ornn8/fork' }), pullRequestAfter: pullRequest({ headRepository: 'ornn8/fork' }) }), 'fork-head'],
    [input({ linkedIssueSnapshot: { complete: true, issues: [] } }), 'missing-linked-issue'],
    [input({ linkedIssueSnapshot: { complete: true, issues: [linkedIssue({ repository: 'ornn8/other' })] } }), 'linked-issue-outside-repository'],
    [input({ linkedIssueSnapshot: { complete: true, issues: [linkedIssue({ type: 'pull-request' })] } }), 'linked-subject-not-issue'],
    [input({ linkedIssueSnapshot: { complete: true, issues: [linkedIssue({ state: 'closed' })] } }), 'linked-issue-not-open'],
  ]
  for (const [candidate, reason] of cases) {
    const result = normalizePullRequestSubjectSnapshot(candidate)
    assert.equal(result.status, 'ineligible', reason)
    assert.equal(result.reason, reason)
  }
})

test('fails closed on stale or malformed exact-head CI evidence', () => {
  const staleHead = '9'.repeat(40)
  const stale = normalizePullRequestSubjectSnapshot(input({
    ciInput: ciInput({
      headSha: staleHead,
      checkSnapshot: { complete: true, headSha: staleHead, checkRuns: [] },
    }),
  }))
  assert.equal(stale.status, 'invalid')
  assert.match(stale.detail, /does not match the pull-request head/i)

  const invalid = normalizePullRequestSubjectSnapshot(input({
    ciInput: ciInput({ checkSnapshot: { complete: false, headSha, checkRuns: [] } }),
  }))
  assert.equal(invalid.status, 'invalid')
  assert.match(invalid.detail, /CI evidence is invalid/i)
})

test('requires one complete internally consistent linked task Issue snapshot', () => {
  const duplicate = linkedIssue()
  const idempotent = normalizePullRequestSubjectSnapshot(input({
    linkedIssueSnapshot: { complete: true, issues: [duplicate, { ...duplicate }] },
  }))
  assert.equal(idempotent.status, 'ok')

  const cases = [
    { complete: false, issues: [linkedIssue()] },
    { complete: true, issues: [linkedIssue(), linkedIssue({ number: 6 })] },
    { complete: true, issues: [linkedIssue(), linkedIssue({ state: 'closed' })] },
    { complete: true, issues: [{ ...linkedIssue(), extra: true }] },
  ]
  for (const linkedIssueSnapshot of cases) {
    const result = normalizePullRequestSubjectSnapshot(input({ linkedIssueSnapshot }))
    assert.equal(result.status, 'invalid')
  }
})

test('distinguishes disabled repair from malformed or incomplete repair evidence', () => {
  const disabled = normalizePullRequestSubjectSnapshot(input())
  assert.equal(disabled.status, 'ok')
  assert.deepEqual(disabled.snapshot.repair, { active: false, attempts: 0, limit: 0 })

  for (const repairSnapshot of [
    { complete: false, active: false, attempts: 0, limit: 3 },
    { complete: true, active: 'false', attempts: 0, limit: 3 },
    { complete: true, active: false, attempts: -1, limit: 3 },
    { complete: true, active: false, attempts: 0, limit: 3, extra: true },
  ]) {
    const result = normalizePullRequestSubjectSnapshot(input({ repairSnapshot }))
    assert.equal(result.status, 'invalid')
  }
})

test('rejects wrong subjects, unknown fields, and non-object inputs', () => {
  const functionInput = function subject() {}
  Object.assign(functionInput, input())
  const cases = [
    null,
    [],
    functionInput,
    { ...input(), extra: true },
    input({ repository: 'Ornn8/example' }),
    input({ pullRequestBefore: pullRequest({ number: 8 }), pullRequestAfter: pullRequest({ number: 8 }) }),
    input({ pullRequestBefore: pullRequest({ baseSha: headSha }), pullRequestAfter: pullRequest({ baseSha: headSha }) }),
  ]
  for (const candidate of cases) {
    const result = normalizePullRequestSubjectSnapshot(candidate)
    assert.equal(result.status, 'invalid')
  }
})
