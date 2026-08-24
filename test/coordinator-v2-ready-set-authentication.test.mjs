import assert from 'node:assert/strict'
import test from 'node:test'
import { createTaskClaim } from '../src/coordinator-v2/claim-policy.mjs'
import { selectReadyTaskBatch } from '../src/coordinator-v2/ready-set-policy.mjs'
import { parseTaskDeclaration, taskIdentity } from '../src/coordinator-v2/task-policy.mjs'

const repository = 'Ornn8/example'
const now = '2026-08-23T12:00:00.000Z'
const observedAt = '2026-08-23T12:01:00.000Z'

const body = `## Objective

Build one bounded change.

## Scope

Only this Issue.

## Acceptance criteria

- Focused tests pass.

<!-- agent-task:v1 -->
\`\`\`json
{"version":1,"dispatch":"ready","dependsOn":[]}
\`\`\``

const issue = {
  body,
  number: 1,
  state: 'open',
  trustedAuthor: true,
  type: 'issue',
}

const task = parseTaskDeclaration(body, { issueNumber: issue.number })
const taskId = taskIdentity({ repository, issueNumber: issue.number, task })

test('an authenticated function observation invalidates the ready-set snapshot', () => {
  const claim = createTaskClaim({
    repository,
    issueNumber: issue.number,
    taskId,
    claimant: 'change/runtime-01',
    now,
    leaseMs: 5 * 60 * 1_000,
  })
  const malformed = function authenticatedClaim() {}
  malformed.authenticated = true
  malformed.issueNumber = issue.number
  malformed.projection = claim

  const result = selectReadyTaskBatch({
    repository,
    issues: [issue],
    pullRequests: [],
    claimObservations: [malformed],
    activeLimit: 1,
    batchLimit: 1,
    now: observedAt,
  })

  assert.equal(result.status, 'invalid')
  assert.equal(result.reason, 'invalid-input')
  assert.equal(result.detail, 'Claim observation must be an object')
  assert.deepEqual(result.selected, [])
})
