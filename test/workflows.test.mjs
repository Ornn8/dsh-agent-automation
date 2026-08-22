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

test('reusable workflow commands declare a shell unless their syntax is shell-neutral', async () => {
  const names = (await readdir(workflowDirectory)).filter(name => name.endsWith('.yml'))
  for (const name of names) {
    const source = await readFile(new URL(name, workflowDirectory), 'utf8')
    if (!source.includes('workflow_call:')) continue
    const steps = source.split(/(?=^\s{6}- name:)/m)
    for (const step of steps) {
      const run = step.match(/^\s+run:\s*(.*)$/m)?.[1]?.trim()
      if (!run) continue
      const command = /^[|>][-+]?\d*$/.test(run) ? '<block scalar>' : run
      if (/^(?:node\b.*|exit\s+\d+)$/.test(command)) continue
      assert.match(step, /^\s+shell:\s*\S+/m, `${name} must declare the shell for: ${command}`)
    }
  }
})

test('Agent review publication is job-scoped and landing is a separate workflow', async () => {
  const review = await readFile(new URL('agent-review.yml', workflowDirectory), 'utf8')
  const landing = await readFile(new URL('land-pr.yml', workflowDirectory), 'utf8')
  const landingController = await readFile(new URL('../src/land-pr.mjs', import.meta.url), 'utf8')
  assert.match(review, /checks: write/)
  assert.doesNotMatch(review, /statuses: write/)
  assert.match(review, /name: agent\/review/)
  assert.match(review, /checks: write/)
  assert.match(review, /GITHUB_TOKEN: \$\{\{ github\.token \}\}/)
  assert.doesNotMatch(review, /--auto/)
  assert.match(landing, /node controller\/src\/land-pr\.mjs/)
  assert.match(landing, /PROFILE_ID: \$\{\{ inputs\.profile_id \}\}/)
  assert.match(landingController, /required_status_checks/)
  assert.match(landingController, /cycle\.merge\.strategy/)
  assert.match(landingController, /commit_message: current\.body \|\| ''/)
})

test('controller CI rejects pull requests that exceed the repository review budget', async () => {
  const workflow = await readFile(new URL('controller-ci.yml', workflowDirectory), 'utf8')
  const gate = await readFile(new URL('../scripts/check-pr-size.mjs', import.meta.url), 'utf8')
  assert.match(workflow, /pull_request:\n\s+types: \[opened, synchronize, reopened, edited\]/)
  assert.match(workflow, /name: pull request scope/)
  assert.match(workflow, /fetch-depth: 0/)
  assert.match(workflow, /actions\/setup-node@[0-9a-f]{40}/)
  assert.match(workflow, /node-version: 22/)
  assert.match(workflow, /npm ci --ignore-scripts/)
  assert.match(workflow, /node scripts\/check-pr-size\.mjs/)
  assert.match(workflow, /PR_BODY: \$\{\{ github\.event\.pull_request\.body \}\}/)
  assert.match(workflow, /needs: \[pull-request-scope, test\]/)
  assert.match(gate, /git', \['diff', '--numstat', '--find-renames'/)
  assert.match(gate, /pullRequestBody/)
})
