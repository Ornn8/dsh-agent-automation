import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import test from 'node:test'

const workflowDirectory = new URL('../.github/workflows/', import.meta.url)

test('every privileged reusable workflow pins actions and validates its controller SHA', async () => {
  const names = (await readdir(workflowDirectory)).filter(name => name.endsWith('.yml'))
  assert.ok(names.length >= 9)
  for (const name of names) {
    const source = await readFile(new URL(name, workflowDirectory), 'utf8')
    assert.doesNotMatch(source, /actions\/checkout@v\d/)
    assert.match(source, /actions\/checkout@[0-9a-f]{40}/)
    assert.match(source, /controller_sha must be a full commit SHA/)
  }
})

test('Codex publication is job-scoped and landing is a separate workflow', async () => {
  const review = await readFile(new URL('codex-review.yml', workflowDirectory), 'utf8')
  const landing = await readFile(new URL('land-pr.yml', workflowDirectory), 'utf8')
  assert.match(review, /statuses: write/)
  assert.match(review, /GITHUB_TOKEN: \$\{\{ github\.token \}\}/)
  assert.doesNotMatch(review, /--auto/)
  assert.match(landing, /node controller\/src\/land-pr\.mjs/)
})
