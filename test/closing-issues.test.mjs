import assert from 'node:assert/strict'
import test from 'node:test'
import { sameRepositoryClosingIssues } from '../src/closing-issues.mjs'

test('closing Issue selection accepts only canonical same-repository references', () => {
  assert.deepEqual(sameRepositoryClosingIssues([
    { number: 1, url: 'https://github.com/owner/repo/issues/1' },
    { number: 1, url: 'https://github.com/owner/repo/issues/1' },
    { number: 2, url: 'https://github.com/other/repo/issues/2' },
    { number: 3, url: 'https://github.com/owner/repo/issues/4' },
    { number: 0, url: 'https://github.com/owner/repo/issues/0' },
  ], 'owner/repo'), [1])
  assert.deepEqual(sameRepositoryClosingIssues(null, 'owner/repo'), [])
})
