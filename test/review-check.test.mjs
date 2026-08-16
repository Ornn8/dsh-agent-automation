import assert from 'node:assert/strict'
import test from 'node:test'
import {
  completeReviewCheck,
  failReviewCheck,
  hasNewReviewCheck,
  parseReviewCheckIdentity,
  REVIEW_CHECK_NAME,
  reviewCheckIdentity,
  startReviewCheck,
  trustedReviewCheckIds,
} from '../src/review-check.mjs'

const repository = 'owner/repository'
const head = 'a'.repeat(40)
const runUrl = 'https://github.com/owner/repository/actions/runs/17'
const identity = {
  workflowId: 'repair',
  stageId: 'review',
  definitionHash: 'b'.repeat(64),
}
const identityWithRun = { ...identity, runId: 17 }

function recorder(stdout = '{}') {
  const calls = []
  return {
    calls,
    execute: async (...args) => {
      calls.push(args)
      return { stdout }
    },
  }
}

test('the controller creates and completes its exact-head review CheckRun', async () => {
  const created = recorder('{"id":91}')
  const checkId = await startReviewCheck({ ghExecutable: 'gh', repository, head, runUrl, identity, execute: created.execute })
  assert.equal(checkId, 91)
  assert.deepEqual(created.calls[0][1], [
    'api', '--method', 'POST', `repos/${repository}/check-runs`,
    '-f', `name=${REVIEW_CHECK_NAME}`, '-f', `head_sha=${head}`, '-f', 'status=in_progress', '-f', `details_url=${runUrl}`, '-f', `external_id=${reviewCheckIdentity(identityWithRun)}`,
    '-f', 'output[title]=Agent review in progress', '-f', 'output[summary]=Reviewing this exact pull request head.',
  ])

  const completed = recorder()
  await completeReviewCheck({ ghExecutable: 'gh', repository, checkId, runUrl, conclusion: 'success', summary: 'Passed.', execute: completed.execute })
  assert.deepEqual(completed.calls[0][1], [
    'api', '--method', 'PATCH', `repos/${repository}/check-runs/${checkId}`,
    '-f', 'status=completed', '-f', 'conclusion=success', '-f', `details_url=${runUrl}`,
    '-f', 'output[title]=Agent review success', '-f', 'output[summary]=Passed.',
  ])
})

test('review CheckRun identity binds the trusted Profile workflow and rejects malformed metadata', () => {
  const external_id = reviewCheckIdentity(identityWithRun)
  assert.deepEqual(parseReviewCheckIdentity({ external_id }), identityWithRun)
  assert.equal(parseReviewCheckIdentity({ external_id: `${external_id}:extra` }), null)
  assert.equal(parseReviewCheckIdentity({ external_id: 'https://github.com/owner/repository/actions/runs/17' }), null)
  assert.throws(() => reviewCheckIdentity({ ...identityWithRun, workflowId: 'bad workflow' }), /incomplete/)
  assert.throws(() => reviewCheckIdentity(identity), /incomplete/)
})

test('review CheckRun creation rejects an unrelated or malformed Actions run URL', async () => {
  const created = recorder('{"id":91}')
  await assert.rejects(
    startReviewCheck({ ghExecutable: 'gh', repository, head, runUrl: 'https://github.com/other/repository/actions/runs/17', identity, execute: created.execute }),
    /does not identify/,
  )
  await assert.rejects(
    startReviewCheck({ ghExecutable: 'gh', repository, head, runUrl: `https://github.com/${repository}/runs/17`, identity, execute: created.execute }),
    /does not identify/,
  )
  assert.equal(created.calls.length, 0)
})

test('an infrastructure failure creates a terminal exact-head review CheckRun', async () => {
  const failed = recorder()
  await failReviewCheck({ ghExecutable: 'gh', repository, head, runUrl, summary: 'Infrastructure failure.', execute: failed.execute })
  assert.deepEqual(failed.calls[0][1].slice(0, 16), [
    'api', '--method', 'POST', `repos/${repository}/check-runs`,
    '-f', `name=${REVIEW_CHECK_NAME}`, '-f', `head_sha=${head}`, '-f', 'status=completed', '-f', 'conclusion=failure', '-f', `details_url=${runUrl}`, '-f', `external_id=${runUrl}`,
  ])
})

test('same-head repair recognizes a newly started trusted review after its label is consumed', () => {
  const check = (id, overrides = {}) => ({
    id,
    name: REVIEW_CHECK_NAME,
    head_sha: head,
    details_url: `https://github.com/${repository}/runs/${id}`,
    app: { id: 15368 },
    ...overrides,
  })
  const before = trustedReviewCheckIds({ total_count: 1, check_runs: [check(17)] }, { repository, head })
  const after = trustedReviewCheckIds({ total_count: 2, check_runs: [check(17), check(18, {
    details_url: `https://github.com/${repository}/actions/runs/22/job/18`,
  })] }, { repository, head })
  assert.equal(hasNewReviewCheck(before, after), true)
  assert.equal(hasNewReviewCheck(after, after), false)
})

test('same-head repair rejects untrusted or incomplete review snapshots', () => {
  const response = overrides => ({ total_count: 1, check_runs: [{
    id: 17,
    name: REVIEW_CHECK_NAME,
    head_sha: head,
    details_url: `https://github.com/${repository}/runs/17`,
    app: { id: 15368 },
    ...overrides,
  }] })
  assert.equal(trustedReviewCheckIds(response({ app: { id: 1 } }), { repository, head }).size, 0)
  assert.equal(trustedReviewCheckIds(response({ details_url: 'https://example.com/owner/repository/runs/17' }), { repository, head }).size, 0)
  assert.equal(trustedReviewCheckIds(response({ head_sha: 'b'.repeat(40) }), { repository, head }).size, 0)
  assert.throws(() => trustedReviewCheckIds({ total_count: 2, check_runs: [] }, { repository, head }), /incomplete/)
})
