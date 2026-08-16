import assert from 'node:assert/strict'
import test from 'node:test'

import { evaluatePullRequestSize, measureGitNumstat } from '../src/pull-request-size.mjs'

test('pull request size accepts reviewable changes and rejects either exceeded limit', () => {
  assert.deepEqual(evaluatePullRequestSize({ files: 40, changedLines: 2_000 }), {
    accepted: true,
    message: 'Pull request size is reviewable: 40 files and 2000 changed lines.',
  })
  assert.deepEqual(evaluatePullRequestSize({ files: 41, changedLines: 1 }), {
    accepted: false,
    message: 'Pull request size exceeds the 40-file limit: 41 files and 1 changed line. Split the change into independently reviewable pull requests.',
  })
  assert.deepEqual(evaluatePullRequestSize({ files: 1, changedLines: 2_001 }), {
    accepted: false,
    message: 'Pull request size exceeds the 2000-line limit: 1 file and 2001 changed lines. Split the change into independently reviewable pull requests.',
  })
})

test('git numstat counts files and text changes without treating binary bytes as lines', () => {
  assert.deepEqual(measureGitNumstat([
    '12\t3\tsrc/changed.mjs',
    '-\t-\tfixtures/image.png',
    '1\t0\tdocs/readme.md',
    '',
  ].join('\n')), { files: 3, changedLines: 16 })
  assert.throws(() => measureGitNumstat('unknown\t1\tbad.txt'), /invalid addition count/)
})
