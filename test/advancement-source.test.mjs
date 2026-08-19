import assert from 'node:assert/strict'
import test from 'node:test'
import { terminalReviewSource } from '../src/advancement-source.mjs'

const sha = letter => letter.repeat(40)

function source(overrides = {}) {
  return {
    id: 30,
    run_attempt: 2,
    repository: { full_name: 'owner/target' },
    name: 'Agent PR Review',
    status: 'completed',
    display_title: `Agent PR Review #12 ${sha('a')}..${sha('b')}`,
    referenced_workflows: [{ path: `owner/controller/.github/workflows/agent-review.yml@${sha('c')}`, sha: sha('c') }],
    ...overrides,
  }
}

const expected = {
  runId: 30,
  runAttempt: 2,
  repository: 'owner/target',
  controllerRepository: 'owner/controller',
  controllerSha: sha('c'),
  workflowPath: '.github/workflows/agent-review.yml',
}

test('a terminal workflow_run source derives the exact reviewed subject', () => {
  assert.deepEqual(terminalReviewSource(source(), expected), { number: 12, base: sha('a'), head: sha('b') })
})

test('a pre-terminal review workflow can never be used as an advancement source', () => {
  assert.throws(() => terminalReviewSource(source({ status: 'in_progress' }), expected), /completed trusted exact-pair/)
})

test('a source without the pinned reusable review workflow cannot wake advancement', () => {
  assert.throws(() => terminalReviewSource(source({ referenced_workflows: [] }), expected), /completed trusted exact-pair/)
})
