import assert from 'node:assert/strict'
import test from 'node:test'
import { capacityWaitStatusLine } from '../src/capacity-wait-projection.mjs'
import {
  completeReviewCheck,
  failReviewCheck,
  hasNewReviewCheck,
  parseReviewCheckIdentity,
  REVIEW_CHECK_NAME,
  reviewCheckIdentity,
  startReviewCheck,
  startDeferredReviewCheck,
  trustedReviewCheckIds,
  trustedDeferredReviewCheckId,
  trustedDeferredReviewProjection,
} from '../src/review-check.mjs'

const repository = 'owner/repository'
const head = 'a'.repeat(40)
const runUrl = 'https://github.com/owner/repository/actions/runs/17'
const identity = {
  workflowId: 'repair',
  stageId: 'review',
  definitionHash: 'b'.repeat(64),
}
const identityWithRun = { ...identity, runId: 17, runAttempt: 2 }
const capacityProjection = {
  version: 1,
  workRequestId: `review-pr-12-${'a'.repeat(40)}-${head}`,
  role: 'review',
  profileId: 'github-pr-cycle',
  workflowId: 'repair',
  stageId: 'review',
  definitionHash: identity.definitionHash,
  revision: { base: 'a'.repeat(40), head },
  subject: {
    type: 'pull-request', number: 12, stateVersion: 'c'.repeat(64),
    base: 'a'.repeat(40), head,
  },
  routeDecision: {
    version: 1,
    workRequestId: `review-pr-12-${'a'.repeat(40)}-${head}`,
    role: 'review', stateVersion: 'c'.repeat(64), taskClass: 'default',
    policyHash: 'd'.repeat(64), evidenceHash: 'e'.repeat(64),
  },
  capacityGenerationHash: 'f'.repeat(64),
  observationId: '17:2',
}
const capacitySummary = `No review Worker was available because all routed capacity was deferred.\n${capacityWaitStatusLine(capacityProjection)}`

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
  const checkId = await startReviewCheck({ ghExecutable: 'gh', repository, head, runUrl, runAttempt: 2, identity, execute: created.execute })
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

test('capacity-deferred creates one neutral exact-head CheckRun and recognizes a trusted prior one', async () => {
  const created = recorder('{"id":91}')
  await startDeferredReviewCheck({
    ghExecutable: 'gh', repository, head, runUrl, runAttempt: 2, identity,
    summary: 'No review Worker was available because all routed capacity was deferred.', capacityProjection,
    execute: created.execute,
  })
  assert.deepEqual(created.calls[0][1], [
    'api', '--method', 'POST', `repos/${repository}/check-runs`,
    '-f', `name=${REVIEW_CHECK_NAME}`, '-f', `head_sha=${head}`, '-f', 'status=completed', '-f', 'conclusion=neutral', `-f`, `details_url=${runUrl}`,
    '-f', `external_id=${reviewCheckIdentity(identityWithRun)}`,
    '-f', 'output[title]=Agent review neutral',
    `-f`, `output[summary]=${capacitySummary}`,
  ])
  const response = {
    total_count: 4,
    check_runs: [
      { id: 90, name: REVIEW_CHECK_NAME, head_sha: head, status: 'completed', conclusion: 'neutral',
        details_url: runUrl, app: { id: 15368 }, output: { title: 'Agent review neutral', summary: 'old' }, external_id: reviewCheckIdentity({ ...identityWithRun, runId: 16 }) },
      { id: 91, name: REVIEW_CHECK_NAME, head_sha: head, status: 'completed', conclusion: 'neutral',
        details_url: runUrl, app: { id: 15368 }, output: { title: 'Agent review neutral', summary: capacitySummary }, external_id: reviewCheckIdentity(identityWithRun) },
      { id: 92, name: REVIEW_CHECK_NAME, head_sha: head, status: 'completed', conclusion: 'neutral',
        details_url: runUrl, app: { id: 15368 }, output: { title: 'Agent review neutral' }, external_id: 'agent-review-v2:repair:review:' + 'b'.repeat(64) + ':17:2' },
      { id: 93, name: REVIEW_CHECK_NAME, head_sha: head, status: 'completed', conclusion: 'neutral',
        details_url: runUrl, app: { id: 1 }, output: { title: 'Agent review neutral' }, external_id: reviewCheckIdentity({ ...identityWithRun, workflowId: 'other' }) },
    ],
  }
  const replay = recorder('{"id":94}')
  const replayId = trustedDeferredReviewCheckId(response, { repository, head, identity: identityWithRun })
    ?? await startDeferredReviewCheck({
      ghExecutable: 'gh', repository, head, runUrl, runAttempt: 2, identity,
      summary: 'No review Worker was available because all routed capacity was deferred.',
      execute: replay.execute,
    })
  assert.equal(replayId, 91)
  const trustedProjection = { isTrustedReviewCheck: check => [91, 94].includes(check.id) }
  assert.deepEqual(trustedDeferredReviewProjection(response, { repository, head, ...trustedProjection }), capacityProjection)
  assert.equal(trustedDeferredReviewProjection({
    total_count: 5,
    check_runs: [...response.check_runs, {
      id: 94, name: REVIEW_CHECK_NAME, head_sha: head, status: 'completed', conclusion: 'neutral',
      details_url: runUrl, app: { id: 15368 }, output: { title: 'Agent review neutral' },
      external_id: reviewCheckIdentity(identityWithRun),
    }],
  }, { repository, head, ...trustedProjection }), null, 'a newer malformed neutral projection must fail closed')
  assert.equal(trustedDeferredReviewProjection(response, { repository, head }), null, 'a projection without exact Actions provenance must not authorize resume')
  assert.deepEqual(trustedDeferredReviewProjection({
    total_count: 5,
    check_runs: [...response.check_runs, {
      id: 95, name: REVIEW_CHECK_NAME, head_sha: head, status: 'completed', conclusion: 'neutral',
      details_url: runUrl, app: { id: 15368 }, output: { title: 'Agent review neutral', summary: capacitySummary },
      external_id: reviewCheckIdentity({ ...identityWithRun, workflowId: 'other' }),
    }],
  }, { repository, head, isTrustedReviewCheck: check => check.id !== 95 && [91, 94].includes(check.id) }), capacityProjection,
  'an untrusted newer neutral must not hide an older trusted projection')
  assert.equal(replay.calls.length, 0, 'trusted neutral replay must not create another CheckRun')
  assert.equal(trustedDeferredReviewCheckId({ ...response, check_runs: response.check_runs.map(check => ({ ...check, conclusion: 'failure' })) }, { repository, head, identity: identityWithRun }), null)
  assert.equal(trustedDeferredReviewCheckId({ ...response, check_runs: response.check_runs.map(check => ({ ...check, external_id: undefined })) }, { repository, head, identity: identityWithRun }), null)
  assert.equal(trustedDeferredReviewCheckId({ ...response, check_runs: response.check_runs.map(check => ({ ...check, external_id: reviewCheckIdentity({ ...identityWithRun, definitionHash: 'c'.repeat(64) }) })) }, { repository, head, identity: identityWithRun }), null)
  assert.equal(trustedDeferredReviewCheckId(response, { repository, head, identity: { ...identityWithRun, runId: 18 } }), null)
  assert.equal(trustedDeferredReviewCheckId(response, { repository, head, identity: { ...identityWithRun, runAttempt: 3 } }), null)
})

test('review CheckRun identity binds the trusted Profile workflow and rejects malformed metadata', () => {
  const external_id = reviewCheckIdentity(identityWithRun)
  assert.deepEqual(parseReviewCheckIdentity({ external_id }), identityWithRun)
  assert.equal(parseReviewCheckIdentity({ external_id: `${external_id}:extra` }), null)
  assert.equal(parseReviewCheckIdentity({ external_id: 'https://github.com/owner/repository/actions/runs/17' }), null)
  assert.throws(() => reviewCheckIdentity({ ...identityWithRun, workflowId: 'bad workflow' }), /incomplete/)
  assert.throws(() => reviewCheckIdentity({ ...identityWithRun, runAttempt: 0 }), /incomplete/)
  assert.throws(() => reviewCheckIdentity({ ...identity, runId: 17 }), /incomplete/)
})

test('review CheckRun creation rejects an unrelated or malformed Actions run URL', async () => {
  const created = recorder('{"id":91}')
  await assert.rejects(
    startReviewCheck({ ghExecutable: 'gh', repository, head, runUrl: 'https://github.com/other/repository/actions/runs/17', runAttempt: 2, identity, execute: created.execute }),
    /does not identify/,
  )
  await assert.rejects(
    startReviewCheck({ ghExecutable: 'gh', repository, head, runUrl: `https://github.com/${repository}/runs/17`, runAttempt: 2, identity, execute: created.execute }),
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
