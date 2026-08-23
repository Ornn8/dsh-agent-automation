import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import {
  createClaimWorkflowGitHubAdapter,
  createGitHubApiClient,
  parseClaimWorkflowEnvironment,
  runClaimWorkflow,
} from '../src/coordinator-v2/claim-workflow.mjs'

const baseEnv = {
  TARGET_REPOSITORY: 'Ornn8/example',
  ISSUE_NUMBER: '7',
  EXPECTED_TASK_ID: `task-${'a'.repeat(64)}`,
  CLAIMANT: 'change/runtime-01',
  CLAIM_LEASE_SECONDS: '300',
  CLAIM_APP_SLUG: 'ornn8-claim-writer',
  CLAIM_APP_LOGIN: 'ornn8-claim-writer[bot]',
  CONTROLLER_REPOSITORY: 'Ornn8/dsh-agent-automation',
  CONTROLLER_WORKFLOW_PATH: '.github/workflows/coordinator-v2-claim.yml',
  CONTROLLER_SHA: 'b'.repeat(40),
  SOURCE_RUN_ID: '123',
  SOURCE_RUN_ATTEMPT: '2',
  TARGET_GITHUB_TOKEN: 'target-token',
  CONTROLLER_GITHUB_TOKEN: 'controller-token',
  GITHUB_API_URL: 'https://api.github.com',
}

const taskBody = dependencies => `## Objective\n\nBuild one bounded change.\n\n## Scope\n\nOnly this Issue.\n\n## Acceptance criteria\n\n- Focused tests pass.\n\n<!-- agent-task:v1 -->\n\`\`\`json\n${JSON.stringify({ version: 1, dispatch: 'ready', dependsOn: dependencies })}\n\`\`\``

test('central workflow environment is strict and derives one fresh Claim configuration', () => {
  const parsed = parseClaimWorkflowEnvironment(baseEnv, new Date('2026-08-24T00:00:00.000Z'))
  assert.deepEqual(parsed.request, {
    repository: 'ornn8/example',
    issueNumber: 7,
    expectedTaskId: baseEnv.EXPECTED_TASK_ID,
    claimant: baseEnv.CLAIMANT,
  })
  assert.equal(parsed.config.controller.repository, 'ornn8/dsh-agent-automation')
  assert.equal(parsed.config.now, '2026-08-24T00:00:00.000Z')
  assert.equal(parsed.config.leaseMs, 300_000)
  assert.throws(() => parseClaimWorkflowEnvironment({
    ...baseEnv,
    CLAIM_APP_SLUG: 'github-actions',
    CLAIM_APP_LOGIN: 'github-actions[bot]',
  }), /Dedicated Claim App/)
  assert.throws(() => parseClaimWorkflowEnvironment({ ...baseEnv, CLAIM_APP_LOGIN: 'other[bot]' }), /does not match/)
  assert.throws(() => parseClaimWorkflowEnvironment({ ...baseEnv, CLAIM_LEASE_SECONDS: '59' }), /60 through 21600/)
})

test('GitHub API client sends one masked Bearer request and rejects unsafe responses', async () => {
  const seen = []
  const client = createGitHubApiClient({
    token: 'secret',
    fetchImpl: async (url, options) => {
      seen.push({ url, options })
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    },
  })
  assert.deepEqual(await client.request('/repos/o/r'), { ok: true })
  assert.equal(seen[0].options.headers.authorization, 'Bearer secret')
  assert.equal(seen[0].options.headers['x-github-api-version'], '2022-11-28')
  await assert.rejects(client.request('https://evil.invalid'), /path/)

  const failing = createGitHubApiClient({
    token: 'secret',
    fetchImpl: async () => new Response(JSON.stringify({ message: 'denied' }), { status: 403 }),
  })
  await assert.rejects(failing.request('/repos/o/r'), /403.*denied/)
})

test('adapter reads dependencies, same-repository closing PRs, comments, and the central source run', async () => {
  const target = {
    request: async (path, options = {}) => {
      if (path === '/repos/ornn8/example/issues/7') {
        return { number: 7, state: 'open', body: taskBody([4]), author_association: 'OWNER' }
      }
      if (path === '/repos/ornn8/example/issues/4') {
        return { number: 4, state: 'closed', body: '', author_association: 'NONE' }
      }
      if (path === '/graphql' && options.method === 'POST') {
        return { data: { repository: { issue: { closedByPullRequestsReferences: {
          nodes: [
            { number: 9, state: 'OPEN', repository: { nameWithOwner: 'Ornn8/example' } },
            { number: 10, state: 'OPEN', repository: { nameWithOwner: 'fork/example' } },
            { number: 11, state: 'CLOSED', repository: { nameWithOwner: 'Ornn8/example' } },
          ],
          pageInfo: { hasNextPage: false, endCursor: null },
        } } } } }
      }
      if (path === '/repos/ornn8/example/issues/7/comments?per_page=100&page=1') {
        return [{
          id: 11,
          body: 'hello',
          user: { login: 'person', type: 'User' },
          performed_via_github_app: null,
        }]
      }
      throw new Error(`unexpected ${options.method || 'GET'} ${path}`)
    },
  }
  const controller = {
    request: async path => {
      assert.equal(path, '/repos/ornn8/dsh-agent-automation/actions/runs/123')
      return {
        id: 123,
        run_attempt: 2,
        path: '.github/workflows/coordinator-v2-claim.yml',
        head_sha: 'b'.repeat(40),
        repository: { full_name: 'Ornn8/dsh-agent-automation' },
      }
    },
  }
  const adapter = createClaimWorkflowGitHubAdapter({
    targetClient: target,
    controllerClient: controller,
    controllerRepository: 'Ornn8/dsh-agent-automation',
  })
  const snapshot = await adapter.readTaskSnapshot({ repository: 'Ornn8/example', issueNumber: 7, maxComments: 10_000 })
  assert.deepEqual(snapshot.dependencies, [{ number: 4, state: 'closed', type: 'issue' }])
  assert.deepEqual(snapshot.openPullRequests, [{
    repository: 'ornn8/example', issueNumber: 7, number: 9, state: 'open',
  }])
  assert.deepEqual(snapshot.comments, [{
    id: 11, authorLogin: 'person', authorType: 'User', appSlug: '', body: 'hello',
  }])
  assert.equal(snapshot.commentsComplete, true)
  assert.deepEqual(await adapter.loadRun(123), {
    id: 123,
    runAttempt: 2,
    repository: 'Ornn8/dsh-agent-automation',
    controller: {
      repository: 'Ornn8/dsh-agent-automation',
      workflowPath: '.github/workflows/coordinator-v2-claim.yml',
      sha: 'b'.repeat(40),
    },
  })
})

test('adapter scopes Claim comment writes to the exact target repository', async () => {
  const calls = []
  const target = {
    request: async (path, options) => {
      calls.push({ path, options })
      return { id: 44 }
    },
  }
  const adapter = createClaimWorkflowGitHubAdapter({
    targetClient: target,
    controllerClient: { request: async () => ({}) },
    controllerRepository: 'Ornn8/dsh-agent-automation',
  })
  assert.deepEqual(await adapter.createComment({
    repository: 'Ornn8/example', issueNumber: 7, body: 'claim',
  }), { id: 44 })
  assert.deepEqual(await adapter.updateComment({
    repository: 'Ornn8/example', issueNumber: 7, commentId: 44, body: 'claim-2',
  }), { id: 44 })
  assert.deepEqual(calls.map(call => [call.path, call.options.method]), [
    ['/repos/ornn8/example/issues/7/comments', 'POST'],
    ['/repos/ornn8/example/issues/comments/44', 'PATCH'],
  ])
})

test('comment materialization fails closed before an incomplete page can be called complete', async () => {
  const target = {
    request: async path => {
      if (path === '/repos/ornn8/example/issues/7') {
        return { number: 7, state: 'open', body: taskBody([]), author_association: 'OWNER' }
      }
      if (path === '/graphql') {
        return { data: { repository: { issue: { closedByPullRequestsReferences: {
          nodes: [], pageInfo: { hasNextPage: false, endCursor: null },
        } } } } }
      }
      if (path.includes('/comments?')) return [{ id: 1, body: 'a' }, { id: 2, body: 'b' }]
      throw new Error(`unexpected ${path}`)
    },
  }
  const adapter = createClaimWorkflowGitHubAdapter({
    targetClient: target,
    controllerClient: { request: async () => ({}) },
    controllerRepository: 'Ornn8/dsh-agent-automation',
  })
  await assert.rejects(
    adapter.readTaskSnapshot({ repository: 'Ornn8/example', issueNumber: 7, maxComments: 1 }),
    /item limit/,
  )
})

test('workflow runner passes the central source and never dispatches an Agent', async () => {
  let captured
  const lines = []
  const result = await runClaimWorkflow({
    env: baseEnv,
    clock: () => new Date('2026-08-24T00:00:00.000Z'),
    fetchImpl: async () => { throw new Error('stub acquisition should not fetch') },
    acquire: async input => {
      captured = input
      return { status: 'acquired', commentId: 11 }
    },
    write: line => lines.push(line),
  })
  assert.equal(captured.request.repository, 'ornn8/example')
  assert.equal(captured.config.controller.repository, 'ornn8/dsh-agent-automation')
  assert.equal(typeof captured.github.readTaskSnapshot, 'function')
  assert.deepEqual(result, { status: 'acquired', commentId: 11 })
  assert.match(lines[0], /^COORDINATOR_V2_CLAIM_RESULT=/)
})

test('Claim workflow is centralized, serialized, least-privileged, and does not start an Agent', async () => {
  const workflow = await readFile(new URL('../.github/workflows/coordinator-v2-claim.yml', import.meta.url), 'utf8')
  assert.match(workflow, /workflow_dispatch:/)
  assert.doesNotMatch(workflow, /workflow_call:/)
  assert.match(workflow, /group: coordinator-v2-claim:\$\{\{ inputs\.repository \}\}:\$\{\{ inputs\.issue_number \}\}/)
  assert.match(workflow, /cancel-in-progress: false/)
  assert.match(workflow, /environment: coordinator-v2-claim/)
  assert.match(workflow, /permissions:\r?\n\s+actions: read\r?\n\s+contents: read/)
  assert.match(workflow, /actions\/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1/)
  assert.match(workflow, /permission-issues: write/)
  assert.match(workflow, /permission-pull-requests: read/)
  assert.match(workflow, /repositories: \$\{\{ steps\.target\.outputs\.repository_name \}\}/)
  assert.match(workflow, /actions\/checkout@d23441a48e516b6c34aea4fa41551a30e30af803/)
  assert.match(workflow, /ref: \$\{\{ github\.sha \}\}/)
  assert.match(workflow, /node controller\/src\/coordinator-v2\/claim-workflow\.mjs/)
  assert.doesNotMatch(workflow, /self-hosted|agent-change|agent-review|provider|model|contents: write/)
})
