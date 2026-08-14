import assert from 'node:assert/strict'
import test from 'node:test'
import { evaluateLanding } from '../src/landing-policy.mjs'

test('landing accepts only a current exact-pair PASS with every required check green', () => {
  const base = 'a'.repeat(40)
  const head = 'b'.repeat(40)
  const decision = evaluateLanding({
    pullRequest: {
      state: 'OPEN',
      isDraft: false,
      baseRefName: 'master',
      baseRefOid: base,
      headRefOid: head,
      mergeStateStatus: 'CLEAN',
      statusCheckRollup: [
        { __typename: 'StatusContext', context: 'codex/review', state: 'SUCCESS' },
        { __typename: 'CheckRun', name: 'all checks passed', status: 'COMPLETED', conclusion: 'SUCCESS' },
      ],
    },
    expectedHead: head,
    requiredChecks: ['all checks passed', 'codex/review'],
    comments: [{
      body: `<!-- codex-review:${head} -->\n## Codex review: PASS\n\n_Reviewed exact head \`${head}\` against base \`${base}\` with gpt-5.6-sol (medium)._`,
    }],
  })
  assert.deepEqual(decision, { ready: true, reason: 'exact review and required checks passed' })
})

test('landing rejects a head-only PASS after the base changes', () => {
  const reviewedBase = 'a'.repeat(40)
  const currentBase = 'c'.repeat(40)
  const head = 'b'.repeat(40)
  const decision = evaluateLanding({
    pullRequest: {
      state: 'OPEN',
      isDraft: false,
      baseRefName: 'master',
      baseRefOid: currentBase,
      headRefOid: head,
      mergeStateStatus: 'CLEAN',
      statusCheckRollup: [
        { __typename: 'StatusContext', context: 'codex/review', state: 'SUCCESS' },
        { __typename: 'CheckRun', name: 'all checks passed', status: 'COMPLETED', conclusion: 'SUCCESS' },
      ],
    },
    expectedHead: head,
    requiredChecks: ['all checks passed', 'codex/review'],
    comments: [{
      body: `<!-- codex-review:${head} -->\n## Codex review: PASS\n\n_Reviewed exact head \`${head}\` against base \`${reviewedBase}\` with gpt-5.6-sol (medium)._`,
    }],
  })
  assert.deepEqual(decision, { ready: false, reason: 'no exact base and head Codex PASS exists' })
})
