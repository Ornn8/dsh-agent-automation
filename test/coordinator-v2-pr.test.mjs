import assert from 'node:assert/strict'
import test from 'node:test'
import { decidePullRequestAction } from '../src/coordinator-v2/pr-policy.mjs'

const baseSha = '1'.repeat(40)
const headSha = '2'.repeat(40)
const pullRequest = { state: 'open', draft: false, baseSha, headSha, mergeable: true }
const repair = { active: false, attempts: 0, limit: 3 }

test('CI-first and review-first orders converge on one merge decision', () => {
  assert.equal(
    decidePullRequestAction({ pullRequest, ci: { headSha, status: 'passed' }, repair }).action,
    'request-review',
  )
  assert.equal(
    decidePullRequestAction({
      pullRequest,
      ci: { headSha, status: 'passed' },
      review: { baseSha, headSha, status: 'passed' },
      repair,
    }).action,
    'request-merge',
  )
  assert.equal(
    decidePullRequestAction({
      pullRequest,
      ci: { headSha, status: 'pending' },
      review: { baseSha, headSha, status: 'passed' },
      repair,
    }).action,
    'wait-checks',
  )
})

test('stale CI and review evidence never authorize the current pair', () => {
  assert.equal(
    decidePullRequestAction({
      pullRequest,
      ci: { headSha: '3'.repeat(40), status: 'passed' },
      review: { baseSha, headSha, status: 'passed' },
      repair,
    }).action,
    'wait-checks',
  )
  assert.equal(
    decidePullRequestAction({
      pullRequest,
      ci: { headSha, status: 'passed' },
      review: { baseSha, headSha: '3'.repeat(40), status: 'passed' },
      repair,
    }).action,
    'request-review',
  )
})

test('review blocks, CI failures, and conflicts use one bounded repair decision', () => {
  assert.equal(
    decidePullRequestAction({ pullRequest, review: { baseSha, headSha, status: 'blocked' }, repair }).reason,
    'review-blocked',
  )
  assert.equal(
    decidePullRequestAction({
      pullRequest,
      ci: { headSha, status: 'failed' },
      review: { baseSha, headSha, status: 'passed' },
      repair,
    }).reason,
    'checks-failed',
  )
  assert.equal(
    decidePullRequestAction({
      pullRequest: { ...pullRequest, mergeable: false },
      ci: { headSha, status: 'passed' },
      review: { baseSha, headSha, status: 'passed' },
      repair: { active: false, attempts: 3, limit: 3 },
    }).reason,
    'repair-limit',
  )
})

test('draft, closed, and active-repair subjects do not mutate', () => {
  assert.equal(decidePullRequestAction({ pullRequest: { ...pullRequest, draft: true } }).action, 'paused')
  assert.equal(decidePullRequestAction({ pullRequest: { ...pullRequest, state: 'closed' } }).action, 'terminal')
  assert.equal(decidePullRequestAction({ pullRequest, repair: { active: true, attempts: 1, limit: 3 } }).action, 'wait-repair')
})
