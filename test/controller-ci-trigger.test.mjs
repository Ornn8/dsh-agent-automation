import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('Controller CI runs once per pull-request head instead of duplicating push CI', async () => {
  const workflow = await readFile(new URL('../.github/workflows/controller-ci.yml', import.meta.url), 'utf8')
  assert.match(workflow, /^  pull_request:\r?$/m)
  assert.doesNotMatch(workflow, /^  push:\r?$/m)
})
