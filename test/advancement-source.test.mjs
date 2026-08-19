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
    display_title: `Agent PR Review #12 ${sha('a')}..${sha('b')} profile:github-pr-cycle`,
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
test('a terminal workflow_run source derives the exact reviewed subject and Profile', () => {
  assert.deepEqual(terminalReviewSource(source(), expected), {
    number: 12, base: sha('a'), head: sha('b'), profileId: 'github-pr-cycle',
  })
})
test('a terminal source cannot substitute a different custom Profile', () => {
  assert.throws(() => terminalReviewSource(source({
    display_title: `Agent PR Review #12 ${sha('a')}..${sha('b')} profile:custom-profile`,
  }), { ...expected, profileId: 'expected-profile' }), /completed trusted exact-pair/)
})
test('a terminal source requires an explicit Profile token', () => {
  assert.throws(() => terminalReviewSource(source({
    display_title: `Agent PR Review #12 ${sha('a')}..${sha('b')}`,
  }), expected), /completed trusted exact-pair/)
})
