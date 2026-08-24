import assert from 'node:assert/strict'
import test from 'node:test'
import { acquireTaskClaimThroughGateway } from '../src/coordinator-v2/claim-gateway.mjs'
import { createClaimWorkflowGitHubAdapter } from '../src/coordinator-v2/claim-workflow.mjs'
import { parseTaskDeclaration, taskIdentity } from '../src/coordinator-v2/task-policy.mjs'

const repository = 'ornn8/example'
const issueNumber = 7
const controllerRepository = 'ornn8/dsh-agent-automation'
const controllerWorkflowPath = '.github/workflows/coordinator-v2-claim.yml'
const controllerSha = 'b'.repeat(40)
const taskBody = `## Objective

Build one bounded change.

## Scope

Only this Issue.

## Acceptance criteria

- Focused tests pass.

<!-- agent-task:v1 -->
\`\`\`json
{"version":1,"dispatch":"ready","dependsOn":[]}
\`\`\``
const task = parseTaskDeclaration(taskBody, { issueNumber })
assert.ok(task)
const expectedTaskId = taskIdentity({ repository, issueNumber, task })

const request = {
  repository,
  issueNumber,
  expectedTaskId,
  claimant: 'change/runtime-01',
}
const config = {
  author: {
    login: 'ornn8-claim-writer[bot]',
    type: 'Bot',
    appSlug: 'ornn8-claim-writer',
  },
  controller: {
    repository: controllerRepository,
    workflowPath: controllerWorkflowPath,
    sha: controllerSha,
  },
  source: { runId: 123, runAttempt: 1 },
  now: '2026-08-24T00:00:00.000Z',
  leaseMs: 300_000,
}

function gatewayForNodes(nodes) {
  let writes = 0
  const targetClient = {
    request: async (path, options = {}) => {
      if (path === '/repos/ornn8/example/issues/7') {
        return { number: issueNumber, state: 'open', body: taskBody, author_association: 'OWNER' }
      }
      if (path === '/graphql') {
        return { data: { repository: { issue: { closedByPullRequestsReferences: {
          nodes,
          pageInfo: { hasNextPage: false, endCursor: null },
        } } } } }
      }
      if (path === '/repos/ornn8/example/issues/7/comments?per_page=100&page=1') return []
      if (options.method === 'POST' || options.method === 'PATCH') {
        writes += 1
        return { id: 44 }
      }
      throw new Error(`unexpected ${options.method || 'GET'} ${path}`)
    },
  }
  const controllerClient = {
    request: async path => {
      assert.equal(path, '/repos/ornn8/dsh-agent-automation/actions/runs/123/attempts/1')
      return {
        id: 123,
        run_attempt: 1,
        path: controllerWorkflowPath,
        head_sha: controllerSha,
        repository: { full_name: controllerRepository },
      }
    },
  }
  return {
    github: createClaimWorkflowGitHubAdapter({
      targetClient,
      controllerClient,
      controllerRepository,
    }),
    writeCount: () => writes,
  }
}

test('malformed object-shaped pull request nodes block the snapshot before any Claim write', async () => {
  for (const node of [
    { number: 77, state: 'OPEN', repository: { nameWithOwner: 5 } },
    { number: '77', state: 'OPEN', repository: { nameWithOwner: repository } },
    { number: 77, state: 5, repository: { nameWithOwner: repository } },
    { number: 77, state: 'OPEN', repository: 5 },
  ]) {
    const { github, writeCount } = gatewayForNodes([node])
    const result = await acquireTaskClaimThroughGateway({ request, config, github })
    assert.equal(result.status, 'blocked')
    assert.equal(result.reason, 'snapshot-read-failed')
    assert.match(String(result.detail), /closing pull request response is incomplete/i)
    assert.equal(writeCount(), 0)
  }
})

test('primitive nodes remain ignorable while a valid open task pull request still blocks acquisition', async () => {
  const { github, writeCount } = gatewayForNodes([
    null,
    5,
    { number: 77, state: 'OPEN', repository: { nameWithOwner: 'Ornn8/example' } },
  ])
  const result = await acquireTaskClaimThroughGateway({ request, config, github })
  assert.equal(result.status, 'ineligible')
  assert.equal(result.reason, 'open-pull-request')
  assert.equal(writeCount(), 0)
})
