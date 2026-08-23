import assert from 'node:assert/strict'
import test from 'node:test'
import { createTaskClaim } from '../src/coordinator-v2/claim-policy.mjs'
import { renderClaimComment } from '../src/coordinator-v2/claim-comment.mjs'
import { acquireTaskClaimThroughGateway } from '../src/coordinator-v2/claim-gateway.mjs'
import { parseTaskDeclaration, taskIdentity } from '../src/coordinator-v2/task-policy.mjs'

const repository = 'Ornn8/example'
const issueNumber = 7
const now = '2026-08-23T12:02:00.000Z'
const controller = {
  repository: 'Ornn8/dsh-agent-automation',
  workflowPath: '.github/workflows/coordinator-v2-claim.yml',
  sha: 'a'.repeat(40),
}
const author = { login: 'claim-writer[bot]', type: 'Bot', appSlug: 'ornn8-claim-writer' }
const source = { runId: 123, runAttempt: 2 }
const run = {
  id: source.runId,
  runAttempt: source.runAttempt,
  repository,
  controller,
}

const taskBody = (dependsOn = []) => `## Objective\n\nBuild one bounded change.\n\n## Scope\n\nOnly this Issue.\n\n## Acceptance criteria\n\n- Focused tests pass.\n\n<!-- agent-task:v1 -->\n\`\`\`json\n${JSON.stringify({ version: 1, dispatch: 'ready', dependsOn })}\n\`\`\``

function taskId(body = taskBody()) {
  return taskIdentity({
    repository,
    issueNumber,
    task: parseTaskDeclaration(body, { issueNumber }),
  })
}

const request = overrides => ({
  repository,
  issueNumber,
  expectedTaskId: taskId(),
  claimant: 'change/runtime-01',
  ...overrides,
})
const config = overrides => ({ author, controller, source, now, leaseMs: 300_000, ...overrides })
const rawComment = (id, body, overrides = {}) => ({
  id,
  authorLogin: author.login,
  authorType: author.type,
  appSlug: author.appSlug,
  body,
  ...overrides,
})
const claimComment = (claim, id = 11) => rawComment(id, renderClaimComment({
  version: 1,
  claim,
  controller,
  source,
}))

function harness(overrides = {}) {
  const state = {
    issue: {
      number: issueNumber,
      state: 'open',
      type: 'issue',
      trustedAuthor: true,
      body: taskBody(),
      ...overrides.issue,
    },
    dependencies: overrides.dependencies || [],
    openPullRequests: overrides.openPullRequests || [],
    comments: [...(overrides.comments || [])],
    commentsComplete: overrides.commentsComplete ?? true,
  }
  const calls = { snapshot: 0, create: 0, update: 0, loadRun: 0 }
  let nextId = Math.max(10, ...state.comments.map(comment => Number.isSafeInteger(comment?.id) ? comment.id : 0)) + 1
  const github = {
    loadRun: async id => {
      calls.loadRun += 1
      if (overrides.loadRunError) throw new Error('run unavailable')
      return typeof overrides.run === 'function' ? overrides.run(id) : (overrides.run || run)
    },
    readTaskSnapshot: async () => {
      calls.snapshot += 1
      if (overrides.snapshotError) throw new Error('snapshot unavailable')
      if (calls.snapshot > 1 && overrides.postSnapshot) return overrides.postSnapshot(state)
      return state
    },
    createComment: async ({ body }) => {
      calls.create += 1
      if (overrides.createError) throw new Error('create failed')
      const id = overrides.createId || nextId++
      state.comments.push(rawComment(id, body))
      return { id }
    },
    updateComment: async ({ commentId, body }) => {
      calls.update += 1
      if (overrides.updateError) throw new Error('update failed')
      const comment = state.comments.find(item => item.id === commentId)
      if (comment) comment.body = body
      return { id: overrides.updateId || commentId }
    },
  }
  return { github, state, calls }
}

async function acquire(h, requestOverrides = {}, configOverrides = {}) {
  return acquireTaskClaimThroughGateway({
    request: request(requestOverrides),
    config: config(configOverrides),
    github: h.github,
  })
}

test('creates one Claim comment, rereads it, and then reuses it idempotently', async () => {
  const h = harness()
  const first = await acquire(h)
  assert.equal(first.status, 'acquired')
  assert.equal(first.reason, 'claim-created')
  assert.equal(h.calls.create, 1)
  assert.equal(h.calls.snapshot, 2)

  const second = await acquire(h)
  assert.equal(second.status, 'existing')
  assert.equal(second.commentId, first.commentId)
  assert.equal(h.calls.create, 1)
  assert.equal(h.calls.update, 0)
})

test('a current other claimant is busy while expired or stale claims are replaced', async () => {
  const current = createTaskClaim({
    repository,
    issueNumber,
    taskId: taskId(),
    claimant: 'change/runtime-02',
    now: '2026-08-23T12:00:00.000Z',
    leaseMs: 300_000,
  })
  const busy = harness({ comments: [claimComment(current)] })
  assert.equal((await acquire(busy)).status, 'busy')
  assert.equal(busy.calls.create + busy.calls.update, 0)

  const expired = createTaskClaim({
    ...current,
    claimant: 'change/runtime-01',
    now: '2026-08-23T12:00:00.000Z',
    leaseMs: 60_000,
  })
  const replaceExpired = harness({ comments: [claimComment(expired)] })
  const replaced = await acquire(replaceExpired)
  assert.equal(replaced.status, 'acquired')
  assert.equal(replaced.reason, 'claim-replaced')
  assert.equal(replaceExpired.calls.update, 1)

  const stale = createTaskClaim({
    repository,
    issueNumber,
    taskId: `task-${'c'.repeat(64)}`,
    claimant: 'change/runtime-02',
    now: '2026-08-23T12:00:00.000Z',
    leaseMs: 300_000,
  })
  const replaceStale = harness({ comments: [claimComment(stale)] })
  assert.equal((await acquire(replaceStale)).reason, 'claim-replaced')
})

test('dependencies, open pull requests, closed Issues, and task drift are ineligible', async () => {
  const dependencyBody = taskBody([4])
  const waiting = harness({
    issue: { body: dependencyBody },
    dependencies: [{ number: 4, state: 'open', type: 'issue' }],
  })
  assert.equal((await acquire(waiting, { expectedTaskId: taskId(dependencyBody) })).reason, 'open-dependencies')

  const withPr = harness({
    openPullRequests: [{ repository, issueNumber, number: 90, state: 'open' }],
  })
  assert.equal((await acquire(withPr)).reason, 'open-pull-request')
  assert.equal((await acquire(harness({ issue: { state: 'closed' } }))).reason, 'issue-not-open')
  assert.equal((await acquire(harness(), { expectedTaskId: `task-${'d'.repeat(64)}` })).reason, 'task-changed')
})

test('invalid authority and incomplete snapshots fail before any write', async () => {
  const generic = harness()
  const genericResult = await acquire(generic, {}, {
    author: { login: 'github-actions[bot]', type: 'Bot', appSlug: 'github-actions' },
  })
  assert.equal(genericResult.reason, 'invalid-gateway-input')
  assert.equal(generic.calls.snapshot, 0)

  const badRun = harness({ run: { ...run, runAttempt: 3 } })
  assert.equal((await acquire(badRun)).reason, 'invalid-gateway-input')
  assert.equal(badRun.calls.snapshot, 0)

  assert.equal((await acquire(harness({ commentsComplete: false }))).reason, 'snapshot-read-failed')
  assert.equal((await acquire(harness({
    openPullRequests: [
      { repository, issueNumber, number: 90, state: 'open' },
      { repository, issueNumber, number: 91, state: 'open' },
    ],
  }))).reason, 'snapshot-read-failed')
})

test('dedicated-App protocol conflicts fail closed while unrelated noise is ignored', async () => {
  const malformed = harness({ comments: [rawComment(11, 'not a Claim')] })
  assert.equal((await acquire(malformed)).reason, 'invalid-controller-comment')

  const claim = createTaskClaim({
    repository,
    issueNumber,
    taskId: taskId(),
    claimant: 'change/runtime-02',
    now: '2026-08-23T12:00:00.000Z',
    leaseMs: 300_000,
  })
  const duplicate = harness({ comments: [claimComment(claim, 11), claimComment(claim, 12)] })
  assert.equal((await acquire(duplicate)).reason, 'duplicate-controller-comments')

  const noise = harness({ comments: Array.from({ length: 2_000 }, (_, id) => ({ id: id + 1, body: `noise ${id}` })) })
  assert.equal((await acquire(noise)).status, 'acquired')
})

test('write errors and mismatched rereads never report acquisition', async () => {
  assert.equal((await acquire(harness({ createError: true }))).reason, 'claim-write-failed')

  const mismatch = harness({
    postSnapshot: state => ({
      ...state,
      comments: state.comments.map(comment => ({ ...comment, body: 'changed after write' })),
    }),
  })
  assert.equal((await acquire(mismatch)).reason, 'claim-reread-mismatch')

  const taskDrift = harness({
    postSnapshot: state => ({
      ...state,
      issue: { ...state.issue, body: taskBody([9]) },
      dependencies: [{ number: 9, state: 'closed', type: 'issue' }],
    }),
  })
  assert.equal((await acquire(taskDrift)).reason, 'claim-reread-mismatch')

  const expired = createTaskClaim({
    repository,
    issueNumber,
    taskId: taskId(),
    claimant: 'change/runtime-01',
    now: '2026-08-23T12:00:00.000Z',
    leaseMs: 60_000,
  })
  const changedId = harness({ comments: [claimComment(expired)], updateId: 99 })
  assert.equal((await acquire(changedId)).reason, 'claim-write-failed')
})

test('raw comment materialization stays bounded', async () => {
  const comments = Array.from({ length: 10_001 }, (_, id) => ({ id: id + 1, body: `noise ${id}` }))
  assert.equal((await acquire(harness({ comments }))).reason, 'snapshot-read-failed')
})
