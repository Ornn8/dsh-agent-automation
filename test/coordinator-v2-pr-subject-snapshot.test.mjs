import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizePullRequestSubjectSnapshot } from '../src/coordinator-v2/pr-subject-snapshot.mjs'

const repository = 'ornn8/example'
const pullRequestNumber = 7
const baseSha = '1'.repeat(40)
const headSha = '2'.repeat(40)
const updatedAt = '2026-08-24T12:00:00.000Z'

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
  updatedAt,
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

const linkedSnapshot = (issues = [linkedIssue()], overrides = {}) => ({
  complete: true,
  repository,
  pullRequestNumber,
  headSha,
  issues,
  ...overrides,
})

const repairSnapshot = (overrides = {}) => ({
  complete: true,
  repository,
  pullRequestNumber,
  headSha,
  active: false,
  attempts: 1,
  limit: 3,
  ...overrides,
})

const input = overrides => ({
  repository,
  pullRequestNumber,
  repositorySnapshot: { repository, defaultBranch: 'master' },
  pullRequestBefore: pullRequest(),
  pullRequestAfter: pullRequest(),
  ciInput: ciInput(),
  linkedIssueSnapshot: linkedSnapshot(),
  repairSnapshot: null,
  ...overrides,
})

test('normalizes one coherent current task pull request snapshot', () => {
  const result = normalizePullRequestSubjectSnapshot(input({
    pullRequestBefore: pullRequest({ mergeable: null }),
    repairSnapshot: repairSnapshot(),
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

test('detects lifecycle, metadata, and exact-pair drift while allowing mergeability convergence', () => {
  const drifts = [
    ['state', 'closed'],
    ['draft', true],
    ['baseBranch', 'release'],
    ['baseSha', '3'.repeat(40)],
    ['headRepository', 'ornn8/other'],
    ['headSha', '4'.repeat(40)],
    ['updatedAt', '2026-08-24T12:01:00.000Z'],
  ]
  for (const [field, value] of drifts) {
    const result = normalizePullRequestSubjectSnapshot(input({ pullRequestAfter: pullRequest({ [field]: value }) }))
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
    [input({ linkedIssueSnapshot: linkedSnapshot([]) }), 'missing-linked-issue'],
    [input({ linkedIssueSnapshot: linkedSnapshot([linkedIssue({ repository: 'ornn8/other' })]) }), 'linked-issue-outside-repository'],
    [input({ linkedIssueSnapshot: linkedSnapshot([linkedIssue({ type: 'pull-request' })]) }), 'linked-subject-not-issue'],
    [input({ linkedIssueSnapshot: linkedSnapshot([linkedIssue({ state: 'closed' })]) }), 'linked-issue-not-open'],
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

test('requires one complete subject-bound linked task Issue snapshot', () => {
  const duplicate = linkedIssue()
  assert.equal(normalizePullRequestSubjectSnapshot(input({
    linkedIssueSnapshot: linkedSnapshot([duplicate, { ...duplicate }]),
  })).status, 'ok')

  const cases = [
    linkedSnapshot(undefined, { complete: false }),
    linkedSnapshot([linkedIssue(), linkedIssue({ number: 6 })]),
    linkedSnapshot([linkedIssue(), linkedIssue({ state: 'closed' })]),
    linkedSnapshot([{ ...linkedIssue(), extra: true }]),
    linkedSnapshot(undefined, { pullRequestNumber: 8 }),
    linkedSnapshot(undefined, { headSha: '8'.repeat(40) }),
  ]
  for (const linkedIssueSnapshot of cases) {
    assert.equal(normalizePullRequestSubjectSnapshot(input({ linkedIssueSnapshot })).status, 'invalid')
  }
})

test('distinguishes disabled repair from malformed, incomplete, or stale repair evidence', () => {
  const disabled = normalizePullRequestSubjectSnapshot(input())
  assert.equal(disabled.status, 'ok')
  assert.deepEqual(disabled.snapshot.repair, { active: false, attempts: 0, limit: 0 })

  for (const candidate of [
    repairSnapshot({ complete: false }),
    repairSnapshot({ active: 'false' }),
    repairSnapshot({ attempts: -1 }),
    { ...repairSnapshot(), extra: true },
    repairSnapshot({ pullRequestNumber: 8 }),
    repairSnapshot({ headSha: '8'.repeat(40) }),
  ]) {
    assert.equal(normalizePullRequestSubjectSnapshot(input({ repairSnapshot: candidate })).status, 'invalid')
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
    input({ pullRequestBefore: pullRequest({ updatedAt: 'not-a-time' }), pullRequestAfter: pullRequest({ updatedAt: 'not-a-time' }) }),
  ]
  for (const candidate of cases) assert.equal(normalizePullRequestSubjectSnapshot(candidate).status, 'invalid')
})
