import assert from 'node:assert/strict'
import test from 'node:test'

import { evaluatePullRequestSize, measureGitHubPullRequestFiles, measureGitNumstat } from '../src/pull-request-size.mjs'

test('GitHub pull request files count additions and deletions as changed lines', () => {
  assert.deepEqual(measureGitHubPullRequestFiles([
    { filename: 'src/changed.mjs', additions: 12, deletions: 3 },
    { filename: 'fixtures/image.png', additions: 0, deletions: 0 },
    { filename: 'docs/readme.md', additions: 1, deletions: 0 },
  ]), { files: 3, changedLines: 16 })
})

test('GitHub pull request file counts reject malformed API values', () => {
  assert.throws(() => measureGitHubPullRequestFiles([
    { filename: 'src/changed.mjs', additions: 1, deletions: '0' },
  ]), /deletions must be a non-negative integer/)
})

test('pull request size rejects an above-target change without a split rationale', () => {
  const decision = evaluatePullRequestSize({
    files: 8,
    changedLines: 501,
  })

  assert.equal(decision.accepted, false)
})

test('pull request size reports actual counts and both thresholds', () => {
  const decision = evaluatePullRequestSize({ files: 10, changedLines: 500 })

  assert.equal(decision.accepted, true)
  assert.match(decision.message, /actual 10 files and 500 changed lines/)
  assert.match(decision.message, /target <=10 files and <=500 changed lines/)
  assert.match(decision.message, /absolute <=40 files and <=2000 changed lines/)
})

test('pull request size requires a visible rationale for an above-target change', () => {
  const rationale = '## Split rationale\nThe change is one atomic migration and cannot be split without breaking its verification path.'
  const accepted = evaluatePullRequestSize({ files: 8, changedLines: 501, pullRequestBody: rationale })
  assert.equal(accepted.accepted, true)

  for (const pullRequestBody of ['', '## Split rationale\n', '## Split rationale\n<!-- explain here -->', '## Split rationale\nTBD']) {
    const rejected = evaluatePullRequestSize({ files: 8, changedLines: 501, pullRequestBody })
    assert.equal(rejected.accepted, false, pullRequestBody)
    assert.match(rejected.message, /non-empty.*split rationale/i, pullRequestBody)
  }
})

test('pull request size requires an exact visible level-two heading in GFM', () => {
  const rationale = 'The change is one atomic migration and cannot be split.'
  const rejectedBodies = [
    `# Split rationale\n${rationale}`,
    `### Split rationale\n${rationale}`,
    `    ## Split rationale\n${rationale}`,
    `<!--\n## Split rationale\n${rationale}\n-->`,
    `\`\`\`\n## Split rationale\n${rationale}\n\`\`\``,
    `- item\n  ## Split rationale\n  ${rationale}`,
    `- item\n  \`\`\`\n  ## Split rationale\n  ${rationale}`,
    `## Split rationale <!-- hidden -->\n${rationale}`,
    `## Split rationale\n<!-- hidden -->\n${rationale}`,
    `## Split rationale\n${rationale}\n<!--`,
    `## Split rationale\n${rationale}\n\`\`\``,
  ]

  for (const pullRequestBody of rejectedBodies) {
    assert.equal(evaluatePullRequestSize({ files: 8, changedLines: 501, pullRequestBody }).accepted, false, pullRequestBody)
  }
  assert.equal(evaluatePullRequestSize({
    files: 8,
    changedLines: 501,
    pullRequestBody: `## Split rationale ##\n${rationale}`,
  }).accepted, true)
})

test('pull request size rejects absolute caps even with a rationale', () => {
  const pullRequestBody = '## Split rationale\nThe change is one atomic migration and cannot be split.'
  for (const counts of [{ files: 41, changedLines: 1 }, { files: 1, changedLines: 2_001 }]) {
    const decision = evaluatePullRequestSize({ ...counts, pullRequestBody })
    assert.equal(decision.accepted, false, JSON.stringify(counts))
    assert.match(decision.message, /absolute .*cap/i)
  }
})

test('pull request size accepts exact absolute caps with a rationale', () => {
  const decision = evaluatePullRequestSize({
    files: 40,
    changedLines: 2_000,
    pullRequestBody: '## Split rationale\nThe change is one atomic migration and cannot be split.',
  })

  assert.equal(decision.accepted, true)
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
