import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import test from 'node:test'

const workflowDirectory = new URL('../.github/workflows/', import.meta.url)

test('every privileged reusable workflow pins actions and checks out its own immutable workflow revision', async () => {
  const names = (await readdir(workflowDirectory)).filter(name => name.endsWith('.yml'))
  assert.ok(names.length >= 9)
  for (const name of names) {
    const source = await readFile(new URL(name, workflowDirectory), 'utf8')
    if (!source.includes('workflow_call:')) continue
    assert.doesNotMatch(source, /actions\/checkout@v\d/)
    assert.match(source, /actions\/checkout@[0-9a-f]{40}/)
    assert.match(source, /job\.workflow_sha/)
  }
})

test('Codex publication is job-scoped and landing is a separate workflow', async () => {
  const review = await readFile(new URL('codex-review.yml', workflowDirectory), 'utf8')
  const landing = await readFile(new URL('land-pr.yml', workflowDirectory), 'utf8')
  const landingController = await readFile(new URL('../src/land-pr.mjs', import.meta.url), 'utf8')
  assert.match(review, /checks: write/)
  assert.doesNotMatch(review, /statuses: write/)
  assert.match(review, /name: codex\/review/)
  assert.match(review, /checks: write/)
  assert.match(review, /GITHUB_TOKEN: \$\{\{ github\.token \}\}/)
  assert.doesNotMatch(review, /--auto/)
  assert.match(landing, /node controller\/src\/land-pr\.mjs/)
  assert.match(landing, /REQUIRED_CHECKS_JSON: \$\{\{ inputs\.required_checks_json \}\}/)
  assert.doesNotMatch(landingController, /branches\/.*\/protection/)
  assert.match(landingController, /requiredCheckNames\.map\(context => \(\{ context, app_id: 15368 \}\)\)/)
  assert.match(landingController, /--body', current\.body \|\| ''/)
})
