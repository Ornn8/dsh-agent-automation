import assert from 'node:assert/strict'
import test from 'node:test'
import { completeReviewCheck, failReviewCheck, REVIEW_CHECK_NAME, startReviewCheck } from '../src/review-check.mjs'

const repository = 'owner/repository'
const head = 'a'.repeat(40)
const runUrl = 'https://github.com/owner/repository/actions/runs/17'

function recorder(stdout = '{}') {
  const calls = []
  return {
    calls,
    execute: async (...args) => {
      calls.push(args)
      return { stdout }
    },
  }
}

test('the controller creates and completes its exact-head review CheckRun', async () => {
  const created = recorder('{"id":91}')
  const checkId = await startReviewCheck({ ghExecutable: 'gh', repository, head, runUrl, execute: created.execute })
  assert.equal(checkId, 91)
  assert.deepEqual(created.calls[0][1], [
    'api', '--method', 'POST', `repos/${repository}/check-runs`,
    '-f', `name=${REVIEW_CHECK_NAME}`, '-f', `head_sha=${head}`, '-f', 'status=in_progress', '-f', `details_url=${runUrl}`,
    '-f', 'output[title]=Codex review in progress', '-f', 'output[summary]=Reviewing this exact pull request head.',
  ])

  const completed = recorder()
  await completeReviewCheck({ ghExecutable: 'gh', repository, checkId, runUrl, conclusion: 'success', summary: 'Passed.', execute: completed.execute })
  assert.deepEqual(completed.calls[0][1], [
    'api', '--method', 'PATCH', `repos/${repository}/check-runs/${checkId}`,
    '-f', 'status=completed', '-f', 'conclusion=success', '-f', `details_url=${runUrl}`,
    '-f', 'output[title]=Codex review success', '-f', 'output[summary]=Passed.',
  ])
})

test('an infrastructure failure creates a terminal exact-head review CheckRun', async () => {
  const failed = recorder()
  await failReviewCheck({ ghExecutable: 'gh', repository, head, runUrl, summary: 'Infrastructure failure.', execute: failed.execute })
  assert.deepEqual(failed.calls[0][1].slice(0, 14), [
    'api', '--method', 'POST', `repos/${repository}/check-runs`,
    '-f', `name=${REVIEW_CHECK_NAME}`, '-f', `head_sha=${head}`, '-f', 'status=completed', '-f', 'conclusion=failure', '-f', `details_url=${runUrl}`,
  ])
})
