import assert from 'node:assert/strict'
import test from 'node:test'

import { evaluatePullRequestSize, measureGitNumstat } from '../src/pull-request-size.mjs'

test('pull request size accepts changes within the default target and reports actual counts and thresholds', () => {
  const decision = evaluatePullRequestSize({ files: 10, changedLines: 500 })

  assert.equal(decision.accepted, true)
  assert.match(decision.message, /actual 10 files and 500 changed lines/)
  assert.match(decision.message, /target <=10 files and <=500 changed lines/)
  assert.match(decision.message, /absolute <=40 files and <=2000 changed lines/)
})

test('pull request size rejects a file-only target exceed without a split rationale', () => {
  const decision = evaluatePullRequestSize({ files: 11, changedLines: 1 })

  assert.equal(decision.accepted, false)
  assert.match(decision.message, /actual 11 files and 1 changed line/)
  assert.match(decision.message, /target <=10 files and <=500 changed lines/)
  assert.match(decision.message, /non-empty.*split rationale/i)
})

test('pull request size accepts a line-only target exceed with an auditable split rationale', () => {
  const decision = evaluatePullRequestSize({
    files: 1,
    changedLines: 501,
    pullRequestBody: '## Split rationale\nThe change is one atomic migration and cannot be divided without breaking its verification path.',
  })

  assert.equal(decision.accepted, true)
  assert.match(decision.message, /actual 1 file and 501 changed lines/)
  assert.match(decision.message, /target <=10 files and <=500 changed lines/)
})

test('pull request size rejects empty and template split rationales', () => {
  for (const pullRequestBody of [
    '',
    '## Split rationale\n',
    '## Split rationale\n[Describe why this change cannot be split]',
    '## Split rationale\nTBD',
  ]) {
    const decision = evaluatePullRequestSize({ files: 11, changedLines: 1, pullRequestBody })

    assert.equal(decision.accepted, false, pullRequestBody)
    assert.match(decision.message, /non-empty, auditable split rationale/i, pullRequestBody)
  }
})

test('pull request size ignores a split rationale heading inside an HTML comment', () => {
  const decision = evaluatePullRequestSize({
    files: 11,
    changedLines: 1,
    pullRequestBody: '<!--\n## Split rationale\nThis commented template must not authorize the change.\n-->',
  })

  assert.equal(decision.accepted, false)
  assert.match(decision.message, /non-empty, auditable split rationale/i)
})

test('pull request size ignores a split rationale heading inside a fenced code block', () => {
  const decision = evaluatePullRequestSize({
    files: 11,
    changedLines: 1,
    pullRequestBody: '```markdown\n## Split rationale\nThis fenced template must not authorize the change.\n```',
  })

  assert.equal(decision.accepted, false)
  assert.match(decision.message, /non-empty, auditable split rationale/i)
})

test('pull request size rejects absolute caps even with a valid split rationale', () => {
  const pullRequestBody = '## Split rationale\nThis is one atomic migration and cannot be divided without breaking its verification path.'
  for (const counts of [
    { files: 41, changedLines: 1 },
    { files: 1, changedLines: 2_001 },
  ]) {
    const decision = evaluatePullRequestSize({ ...counts, pullRequestBody })

    assert.equal(decision.accepted, false, JSON.stringify(counts))
    assert.match(decision.message, /absolute cap/i, JSON.stringify(counts))
    assert.match(decision.message, /cannot override/i, JSON.stringify(counts))
  }
})

test('pull request size accepts exact absolute caps with a valid split rationale', () => {
  const decision = evaluatePullRequestSize({
    files: 40,
    changedLines: 2_000,
    pullRequestBody: '## Split rationale\nThis is one atomic migration and cannot be divided without breaking its verification path.',
  })

  assert.equal(decision.accepted, true)
  assert.match(decision.message, /actual 40 files and 2000 changed lines/)
  assert.match(decision.message, /absolute <=40 files and <=2000 changed lines/)
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
