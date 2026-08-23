import assert from 'node:assert/strict'
import test from 'node:test'
import {
  decideTaskEligibility,
  parseTaskDeclaration,
  taskIdentity,
} from '../src/coordinator-v2/task-policy.mjs'

const body = dependencies => `## Objective\n\nBuild one bounded change.\n\n## Scope\n\nOnly the requested behavior.\n\n## Acceptance criteria\n\n- The focused tests pass.\n\n<!-- agent-task:v1 -->\n\`\`\`json\n${JSON.stringify({ version: 1, dispatch: 'ready', dependsOn: dependencies })}\n\`\`\``

test('task identity binds repository, Issue, and canonical declaration', () => {
  const first = parseTaskDeclaration(body([8, 3]), { issueNumber: 9 })
  const second = parseTaskDeclaration(body([3, 8]), { issueNumber: 9 })
  assert.deepEqual(first.dependsOn, [3, 8])
  assert.equal(
    taskIdentity({ repository: 'Ornn8/example', issueNumber: 9, task: first }),
    taskIdentity({ repository: 'ornn8/example', issueNumber: 9, task: second }),
  )
  assert.notEqual(
    taskIdentity({ repository: 'Ornn8/example', issueNumber: 9, task: first }),
    taskIdentity({ repository: 'Ornn8/example', issueNumber: 10, task: first }),
  )
})

test('task declarations reject unknown fields, duplicates, and self-dependency', () => {
  assert.throws(() => parseTaskDeclaration(body([9]), { issueNumber: 9 }), /itself/)
  assert.throws(() => parseTaskDeclaration(body([3, 3]), { issueNumber: 9 }), /unique/)
  assert.throws(
    () => parseTaskDeclaration(body([]).replace('"dependsOn":[]', '"dependsOn":[],"worker":"codex"'), { issueNumber: 9 }),
    /unknown fields/,
  )
  assert.throws(() => parseTaskDeclaration(`${body([])}\n<!-- agent-task:v1 -->`, { issueNumber: 9 }), /exactly one/)
})

test('eligibility waits only for explicit open dependencies', () => {
  const ready = decideTaskEligibility({
    repository: 'Ornn8/example',
    issue: { number: 9, state: 'open', body: body([3, 8]) },
    trustedAuthor: true,
    dependencies: [{ number: 3, state: 'closed' }, { number: 8, state: 'closed' }],
  })
  assert.equal(ready.status, 'ready')

  const waiting = decideTaskEligibility({
    repository: 'Ornn8/example',
    issue: { number: 9, state: 'open', body: body([3, 8]) },
    trustedAuthor: true,
    dependencies: [{ number: 3, state: 'closed' }, { number: 8, state: 'open' }],
  })
  assert.deepEqual(waiting.dependencies, [8])
  assert.equal(waiting.status, 'waiting')
})

test('eligibility fails closed for untrusted, missing, or already active work', () => {
  const issue = { number: 9, state: 'open', body: body([]) }
  assert.equal(decideTaskEligibility({ repository: 'Ornn8/example', issue }).reason, 'untrusted-author')
  assert.equal(
    decideTaskEligibility({ repository: 'Ornn8/example', issue, trustedAuthor: true, hasOpenPullRequest: true }).status,
    'active',
  )
  assert.equal(
    decideTaskEligibility({
      repository: 'Ornn8/example',
      issue: { ...issue, body: body([3]) },
      trustedAuthor: true,
    }).reason,
    'dependency-missing',
  )
})
