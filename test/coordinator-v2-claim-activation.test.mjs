import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { acquireTaskClaimThroughGateway } from '../src/coordinator-v2/claim-gateway.mjs'
import { createTaskClaim } from '../src/coordinator-v2/claim-policy.mjs'
import { renderClaimComment } from '../src/coordinator-v2/claim-comment.mjs'
import { parseTaskDeclaration, taskIdentity } from '../src/coordinator-v2/task-policy.mjs'

const repository = 'ornn8/example'
const issueNumber = 7
const controller = {
  repository: 'ornn8/dsh-agent-automation',
  workflowPath: '.github/workflows/coordinator-v2-claim.yml',
  sha: 'a'.repeat(40),
}
const source = { runId: 123, runAttempt: 1 }
const author = { login: 'claim-writer[bot]', type: 'Bot', appSlug: 'claim-writer' }
const now = '2026-08-24T00:02:00.000Z'
const taskBody = `## Objective\n\nBuild one bounded change.\n\n## Scope\n\nOnly this Issue.\n\n## Acceptance criteria\n\n- Focused tests pass.\n\n<!-- agent-task:v1 -->\n\`\`\`json\n{"version":1,"dispatch":"ready","dependsOn":[]}\n\`\`\``
const taskId = taskIdentity({
  repository,
  issueNumber,
  task: parseTaskDeclaration(taskBody, { issueNumber }),
})
const run = { id: 123, runAttempt: 1, repository: controller.repository, controller }
const request = { repository, issueNumber, expectedTaskId: taskId, claimant: 'change/runtime-01' }
const config = { author, controller, source, now, leaseMs: 300_000 }
const noise = count => Array.from({ length: count }, (_, index) => ({ id: index + 1, body: `noise ${index}` }))
const dedicatedComment = (id, claim) => ({
  id,
  authorLogin: author.login,
  authorType: author.type,
  appSlug: author.appSlug,
  body: renderClaimComment({ version: 1, claim, controller, source }),
})

function githubFor(comments) {
  const state = { comments: [...comments] }
  const calls = { create: 0, update: 0 }
  const snapshot = () => ({
    issue: { number: issueNumber, state: 'open', type: 'issue', trustedAuthor: true, body: taskBody },
    dependencies: [],
    openPullRequests: [],
    comments: state.comments,
    commentsComplete: true,
  })
  return {
    calls,
    github: {
      loadRun: async () => run,
      readTaskSnapshot: async () => snapshot(),
      createComment: async ({ body }) => {
        calls.create += 1
        const id = state.comments.length + 1
        state.comments.push(dedicatedComment(id, JSON.parse(body.slice(body.indexOf('\n```json\n') + 9, -4)).claim))
        return { id }
      },
      updateComment: async ({ commentId, body }) => {
        calls.update += 1
        const existing = state.comments.find(comment => comment.id === commentId)
        if (existing) existing.body = body
        return { id: commentId }
      },
    },
  }
}

test('central activation allowlists a canonical target before creating an App token', async () => {
  const workflow = await readFile(new URL('../.github/workflows/coordinator-v2-claim.yml', import.meta.url), 'utf8')
  assert.match(workflow, /github\.ref_type == 'branch'/)
  assert.match(workflow, /github\.ref_name == github\.event\.repository\.default_branch/)
  assert.match(workflow, /actions\/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38/)
  assert.match(workflow, /node-version: 22/)
  assert.match(workflow, /Lowercase target repository in owner\/name form/)
  assert.match(workflow, /repository !== repository\.toLowerCase\(\)/)
  assert.match(workflow, /Number\.isSafeInteger\(issueNumber\)/)
  assert.match(workflow, /COORDINATOR_V2_CLAIM_ALLOWED_REPOSITORIES_JSON/)
  assert.match(workflow, /Target repository is not allowlisted for Coordinator V2 Claim writes/)
  assert.match(workflow, /allowed\.length > 64/)
  assert.match(workflow, /new Set\(normalizedAllowed\)\.size !== normalizedAllowed\.length/)
  assert.ok(workflow.indexOf('Use Node.js 22') < workflow.indexOf('Validate and split the allowlisted target'))
  assert.ok(
    workflow.indexOf('Target repository is not allowlisted')
      < workflow.indexOf('Create a target-scoped Claim App token'),
  )
})

test('a full comment snapshot blocks creation before any remote write', async () => {
  const h = githubFor(noise(10_000))
  const result = await acquireTaskClaimThroughGateway({ request, config, github: h.github })
  assert.equal(result.status, 'blocked')
  assert.equal(result.reason, 'claim-comment-capacity')
  assert.equal(h.calls.create, 0)
  assert.equal(h.calls.update, 0)
})

test('a full snapshot may update its one existing expired Claim without growing', async () => {
  const expired = createTaskClaim({
    repository,
    issueNumber,
    taskId,
    claimant: request.claimant,
    now: '2026-08-23T23:55:00.000Z',
    leaseMs: 60_000,
  })
  const comments = noise(9_999)
  comments.push(dedicatedComment(10_000, expired))
  const h = githubFor(comments)
  const result = await acquireTaskClaimThroughGateway({ request, config, github: h.github })
  assert.equal(result.status, 'acquired')
  assert.equal(result.reason, 'claim-replaced')
  assert.equal(h.calls.create, 0)
  assert.equal(h.calls.update, 1)
})
