import assert from 'node:assert/strict'
import test from 'node:test'
import { evaluateLanding } from '../src/landing-policy.mjs'

const trustedReviewer = { type: 'Bot', login: 'github-actions[bot]' }
const pullRequest = (baseRefOid, headRefOid) => ({
  state: 'OPEN',
  isDraft: false,
  baseRefName: 'master',
  baseRefOid,
  headRefOid,
  mergeStateStatus: 'CLEAN',
  statusCheckRollup: [
    { __typename: 'StatusContext', context: 'codex/review', state: 'SUCCESS' },
    { __typename: 'CheckRun', name: 'all checks passed', status: 'COMPLETED', conclusion: 'SUCCESS' },
  ],
})
const passComment = (base, head, user = trustedReviewer) => ({
  user,
  body: `<!-- codex-review:${head} -->\n## Codex review: PASS\n\n_Reviewed exact head \`${head}\` against base \`${base}\` with gpt-5.6-sol (medium)._`,
})

test('landing accepts only a current exact-pair PASS with every required check green', () => {
  const base = 'a'.repeat(40)
  const head = 'b'.repeat(40)
  const decision = evaluateLanding({
    pullRequest: pullRequest(base, head),
    expectedHead: head,
    requiredChecks: ['all checks passed', 'codex/review'],
    comments: [passComment(base, head)],
  })
  assert.deepEqual(decision, { ready: true, reason: 'exact review and required checks passed' })
})

test('landing rejects a head-only PASS after the base changes', () => {
  const reviewedBase = 'a'.repeat(40)
  const currentBase = 'c'.repeat(40)
  const head = 'b'.repeat(40)
  const decision = evaluateLanding({
    pullRequest: pullRequest(currentBase, head),
    expectedHead: head,
    requiredChecks: ['all checks passed', 'codex/review'],
    comments: [passComment(reviewedBase, head)],
  })
  assert.deepEqual(decision, { ready: false, reason: 'no exact base and head Codex PASS exists' })
})

test('landing rejects an exact-pair PASS comment forged by a pull request author', () => {
  const base = 'a'.repeat(40)
  const head = 'b'.repeat(40)
  const decision = evaluateLanding({
    pullRequest: pullRequest(base, head),
    expectedHead: head,
    requiredChecks: ['all checks passed', 'codex/review'],
    comments: [passComment(base, head, { type: 'User', login: 'pr-author' })],
  })
  assert.deepEqual(decision, { ready: false, reason: 'no exact base and head Codex PASS exists' })
})
