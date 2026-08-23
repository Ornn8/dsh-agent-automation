import assert from 'node:assert/strict'
import test from 'node:test'
import { createTaskClaim } from '../src/coordinator-v2/claim-policy.mjs'
import {
  claimCommentMarker,
  parseClaimComment,
  renderClaimComment,
  selectClaimCommentObservation,
  verifyClaimComment,
} from '../src/coordinator-v2/claim-comment.mjs'

const controllerSha = 'a'.repeat(40)
const controller = {
  repository: 'Ornn8/dsh-agent-automation',
  workflowPath: '.github/workflows/coordinator-v2-claim.yml',
  sha: controllerSha,
}
const author = { login: 'github-actions[bot]', type: 'Bot', appSlug: 'github-actions' }
const expected = {
  author,
  repository: 'Ornn8/example',
  issueNumber: 7,
  controller,
}
const claim = createTaskClaim({
  repository: expected.repository,
  issueNumber: expected.issueNumber,
  taskId: `task-${'b'.repeat(64)}`,
  claimant: 'change/runtime-01',
  now: '2026-08-23T12:00:00.000Z',
  leaseMs: 300_000,
})
const record = {
  version: 1,
  claim,
  controller,
  source: { runId: 123, runAttempt: 2 },
}
const run = {
  id: 123,
  runAttempt: 2,
  repository: 'ornn8/example',
  controller: {
    repository: 'ornn8/dsh-agent-automation',
    workflowPath: controller.workflowPath,
    sha: controllerSha,
  },
}
const comment = (id, body = renderClaimComment(record), overrides = {}) => ({
  id,
  authorLogin: author.login,
  authorType: author.type,
  appSlug: author.appSlug,
  body,
  ...overrides,
})
const loadRun = async () => run

test('claim comments render and parse one canonical strict payload', () => {
  const body = renderClaimComment(record)
  assert.ok(body.startsWith(`${claimCommentMarker}\n`))
  assert.deepEqual(parseClaimComment(body), {
    ...record,
    claim: { ...claim, repository: 'ornn8/example' },
    controller: { ...controller, repository: 'ornn8/dsh-agent-automation' },
  })
  assert.equal(parseClaimComment('ordinary comment'), null)
  assert.throws(() => parseClaimComment(`${body}\ntrailing`), /canonical marker/)
  assert.throws(() => parseClaimComment(`${body}\n${claimCommentMarker}`), /canonical marker/)
  assert.throws(() => renderClaimComment({ ...record, extra: true }), /unknown fields/)
  assert.throws(() => renderClaimComment({ ...record, source: { ...record.source, runAttempt: 0 } }), /positive/)
})

test('one exact controller comment becomes one authenticated claim observation', async () => {
  const selected = await selectClaimCommentObservation({
    comments: [comment(11)],
    expected,
    loadRun,
  })
  assert.equal(selected.status, 'authenticated')
  assert.equal(selected.commentId, 11)
  assert.deepEqual(selected.observation, {
    authenticated: true,
    projection: { ...claim, repository: 'ornn8/example' },
  })
  assert.deepEqual(await verifyClaimComment({ comment: comment(11), expected, loadRun }), selected.record)
})

test('untrusted authors and unrelated comments remain unauthenticated noise', async () => {
  const forged = comment(11, renderClaimComment(record), {
    authorLogin: 'someone-else',
    authorType: 'User',
    appSlug: 'github-actions',
  })
  const selected = await selectClaimCommentObservation({
    comments: [
      forged,
      { id: 12, authorLogin: author.login, authorType: author.type, appSlug: author.appSlug, body: 'normal bot status' },
      ...Array.from({ length: 2000 }, (_, index) => ({ id: 1000 + index, body: `noise ${index}` })),
    ],
    expected,
    loadRun,
  })
  assert.deepEqual(selected, { status: 'none', reason: 'no-controller-comment' })
})

test('trusted malformed markers and wrong provenance fail closed', async () => {
  const malformed = await selectClaimCommentObservation({
    comments: [comment(11, `${claimCommentMarker}\nnot canonical`)],
    expected,
    loadRun,
  })
  assert.equal(malformed.status, 'invalid')
  assert.equal(malformed.reason, 'invalid-controller-comment')

  for (const changed of [
    { expected: { ...expected, issueNumber: 8 }, loadRun },
    { expected: { ...expected, controller: { ...controller, sha: 'c'.repeat(40) } }, loadRun },
    { expected, loadRun: async () => ({ ...run, runAttempt: 3 }) },
    { expected, loadRun: async () => ({ ...run, repository: 'ornn8/other' }) },
    { expected, loadRun: async () => ({ ...run, controller: { ...run.controller, workflowPath: '.github/workflows/other.yml' } }) },
  ]) {
    const result = await selectClaimCommentObservation({
      comments: [comment(11)],
      expected: changed.expected,
      loadRun: changed.loadRun,
    })
    assert.equal(result.status, 'invalid')
    assert.equal(result.reason, 'invalid-controller-comment')
  }
})

test('duplicate controller comments and contradictory duplicate observations fail closed', async () => {
  const duplicate = await selectClaimCommentObservation({
    comments: [comment(11), comment(12)],
    expected,
    loadRun,
  })
  assert.deepEqual(duplicate, { status: 'invalid', reason: 'duplicate-controller-comments' })

  const idempotent = await selectClaimCommentObservation({
    comments: [comment(11), comment(11)],
    expected,
    loadRun,
  })
  assert.equal(idempotent.status, 'authenticated')

  const contradictory = await selectClaimCommentObservation({
    comments: [comment(11), comment(11, `${renderClaimComment(record)}\nchanged`)],
    expected,
    loadRun,
  })
  assert.equal(contradictory.status, 'invalid')
  assert.equal(contradictory.reason, 'conflicting-comment-observation')
})

test('strict source run and author input cannot be weakened by unknown fields', async () => {
  const extraComment = await selectClaimCommentObservation({
    comments: [{ ...comment(11), extra: true }],
    expected,
    loadRun,
  })
  assert.equal(extraComment.reason, 'malformed-controller-comment')

  const extraRun = await selectClaimCommentObservation({
    comments: [comment(11)],
    expected,
    loadRun: async () => ({ ...run, extra: true }),
  })
  assert.equal(extraRun.reason, 'invalid-controller-comment')

  const invalidExpected = await selectClaimCommentObservation({
    comments: [comment(11)],
    expected: { ...expected, author: { ...author, type: 'User' } },
    loadRun,
  })
  assert.equal(invalidExpected.reason, 'invalid-input')
})
