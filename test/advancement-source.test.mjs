import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { terminalReviewSource, terminalReviewSourceAfterSettling } from '../src/advancement-source.mjs'
import { reviewAdvancementPayload } from '../src/review-advancement.mjs'
const sha = letter => letter.repeat(40)
function source(overrides = {}) {
  return {
    id: 30,
    run_attempt: 2,
    repository: { full_name: 'owner/target' },
    name: 'Agent PR Review #12 a dynamic run name',
    path: '.github/workflows/agent-pr-review.yml',
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

test('a dynamic review run name is accepted only with the fixed target workflow path', () => {
  assert.doesNotThrow(() => terminalReviewSource(source(), expected))
  assert.throws(() => terminalReviewSource(source({ path: '.github/workflows/other.yml' }), expected), /completed trusted exact-pair/)
})

test('a direct wake settles a closing source workflow before validating its completed CheckRun', async () => {
  const runs = [source({ status: 'in_progress' }), source({ status: 'completed' })]
  assert.deepEqual(await terminalReviewSourceAfterSettling(
    async () => runs.shift(), expected, { wait: async () => undefined },
  ), { number: 12, base: sha('a'), head: sha('b'), profileId: 'github-pr-cycle' })
})

test('terminal PASS and BLOCK payloads carry one exact source attempt and stable request id', () => {
  const input = {
    repository: 'owner/target', pullRequestNumber: 12, baseSha: sha('a'), headSha: sha('b'),
    profileId: 'github-pr-cycle', workflowId: 'default', sourceRunId: 30, sourceRunAttempt: 2,
  }
  const pass = reviewAdvancementPayload({ ...input, verdict: 'pass' })
  const block = reviewAdvancementPayload({ ...input, verdict: 'block' })
  assert.equal(pass.event_type, 'dsh-advance')
  assert.deepEqual(pass.client_payload, {
    pull_request_number: 12, base_sha: sha('a'), head_sha: sha('b'), profile_id: 'github-pr-cycle',
    workflow_id: 'default', source_run_id: 30, source_run_attempt: 2, request_id: pass.client_payload.request_id,
  })
  assert.equal(block.client_payload.request_id, pass.client_payload.request_id)
  assert.throws(() => reviewAdvancementPayload({ ...input, verdict: 'infrastructure' }), /terminal review verdict/)
})

test('review and target workflows gate direct advancement and transport the source attempt', async () => {
  const reviewWorkflow = await readFile(new URL('../.github/workflows/agent-review.yml', import.meta.url), 'utf8')
  const landingWorkflow = await readFile(new URL('../templates/target/.github/workflows/agent-pr-land.yml', import.meta.url), 'utf8')
  assert.match(reviewWorkflow, /Wake exact-pair advancement after terminal review/)
  assert.match(reviewWorkflow, /steps\.review\.outputs\.verdict == 'pass' \|\| steps\.review\.outputs\.verdict == 'block'/)
  assert.doesNotMatch(reviewWorkflow, /steps\.review\.outcome == 'failure'[\s\S]*review-advancement\.mjs/)
  assert.match(landingWorkflow, /client_payload\.source_run_id/)
  assert.match(landingWorkflow, /client_payload\.source_run_attempt/)
  assert.doesNotMatch(landingWorkflow, /workflow_run\.name == 'Agent PR Review'/)
})
