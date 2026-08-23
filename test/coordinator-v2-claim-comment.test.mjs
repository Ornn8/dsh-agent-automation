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
const author = {
  login: 'coordinator-v2-claim[bot]',
  type: 'Bot',
  appSlug: 'coordinator-v2-claim',
}
const genericActionsAuthor = {
  login: 'github-actions[bot]',
  type: 'Bot',
  appSlug: 'github-actions',
}
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

test('claim comments render and parse one canonical bounded payload', () => {
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
  assert.throws(() => renderClaimComment({
    ...record,
    controller: {
      ...controller,
      workflowPath: `.github/workflows/${'a'.repeat(17_000)}.yml`,
    },
  }), /too large/)
})

test('one exact dedicated-App comment becomes one authenticated claim observation', async () => {
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

test('the generic GitHub Actions App cannot be configured as claim authority', async () => {
  const genericExpected = { ...expected, author: genericActionsAuthor }
  const genericComment = comment(11, renderClaimComment(record), {
    authorLogin: genericActionsAuthor.login,
    authorType: genericActionsAuthor.type,
    appSlug: genericActionsAuthor.appSlug,
  })

  const configured = await selectClaimCommentObservation({
    comments: [genericComment],
    expected: genericExpected,
    loadRun,
  })
  assert.equal(configured.status, 'invalid')
  assert.equal(configured.reason, 'invalid-input')
  assert.match(configured.detail, /dedicated claim-writer/)
  await assert.rejects(
    verifyClaimComment({ comment: genericComment, expected: genericExpected, loadRun }),
    /dedicated claim-writer/,
  )

  const noise = await selectClaimCommentObservation({
    comments: [genericComment],
    expected,
    loadRun,
  })
  assert.deepEqual(noise, { status: 'none', reason: 'no-controller-comment' })
})

test('untrusted authors and unrelated comments remain unauthenticated noise', async () => {
  const forged = comment(11, renderClaimComment(record), {
    authorLogin: 'someone-else',
    authorType: 'User',
    appSlug: 'untrusted-app',
  })
  const selected = await selectClaimCommentObservation({
    comments: [
      forged,
      {
        id: 12,
        authorLogin: 'status-bot[bot]',
        authorType: 'Bot',
        appSlug: 'status-bot',
        body: 'normal bot status',
      },
      ...Array.from({ length: 2000 }, (_, index) => ({ id: 1000 + index, body: `noise ${index}` })),
    ],
    expected,
    loadRun,
  })
  assert.deepEqual(selected, { status: 'none', reason: 'no-controller-comment' })
})

test('every comment from the dedicated authority is reserved and malformed content fails closed', async () => {
  for (const body of [
    'normal controller status',
    renderClaimComment(record).replace(claimCommentMarker, '<!-- coordinator-v2-task-clai -->'),
    `${claimCommentMarker}\nnot canonical`,
  ]) {
    const malformed = await selectClaimCommentObservation({
      comments: [comment(11, body)],
      expected,
      loadRun,
    })
    assert.equal(malformed.status, 'invalid')
    assert.equal(malformed.reason, 'invalid-controller-comment')
  }
})

test('wrong target and source-run provenance fail closed', async () => {
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

test('same-id raw contradictions fail before candidate filtering', async () => {
  const canonical = renderClaimComment(record)
  const contradictions = [
    comment(11, 'ordinary comment'),
    comment(11, canonical.replace(claimCommentMarker, '<!-- coordinator-v2-task-clai -->')),
    comment(11, canonical, { authorLogin: 'someone-else' }),
    comment(11, canonical, { appSlug: 'another-app' }),
    { ...comment(11), extra: true },
  ]

  for (const changed of contradictions) {
    const result = await selectClaimCommentObservation({
      comments: [comment(11), changed],
      expected,
      loadRun,
    })
    assert.deepEqual(result, {
      status: 'invalid',
      reason: 'conflicting-comment-observation',
      commentId: 11,
    })
  }
})

test('exact duplicates are idempotent and distinct dedicated-App comments conflict', async () => {
  const idempotent = await selectClaimCommentObservation({
    comments: [comment(11), { ...comment(11) }],
    expected,
    loadRun,
  })
  assert.equal(idempotent.status, 'authenticated')

  const duplicate = await selectClaimCommentObservation({
    comments: [comment(11), comment(12)],
    expected,
    loadRun,
  })
  assert.deepEqual(duplicate, { status: 'invalid', reason: 'duplicate-controller-comments' })

  const malformedDuplicate = await selectClaimCommentObservation({
    comments: [comment(11), comment(12, 'malformed dedicated App comment')],
    expected,
    loadRun,
  })
  assert.deepEqual(malformedDuplicate, { status: 'invalid', reason: 'duplicate-controller-comments' })
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
