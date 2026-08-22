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

test('controller CI leaves pull request size policy to the trusted workflow', async () => {
  const workflow = await readFile(new URL('controller-ci.yml', workflowDirectory), 'utf8')
  const gate = await readFile(new URL('../scripts/check-pr-size.mjs', import.meta.url), 'utf8')
  assert.match(workflow, /pull_request:/)
  assert.doesNotMatch(workflow, /name: pull request scope|check-pr-size\.mjs|PR_BODY: \$\{\{ github\.event\.pull_request\.body \}\}/)
  assert.match(workflow, /needs: \[test\]/)
  assert.match(gate, /git', \['diff', '--numstat', '--find-renames'/)
})

test('trusted pull request size gate measures the event pair without executing candidate policy', async () => {
  const workflow = await readFile(new URL('trusted-pull-request-size.yml', workflowDirectory), 'utf8')
  const controllerCi = await readFile(new URL('controller-ci.yml', workflowDirectory), 'utf8')
  const gate = await readFile(new URL('../scripts/check-pr-size.mjs', import.meta.url), 'utf8')
  assert.match(workflow, /pull_request_target:\s*\r?\n\s+types: \[opened, synchronize, reopened, edited\]/)
  assert.match(workflow, /permissions:\s*\r?\n\s+contents: read\s*\r?\n\s+statuses: write/)
  assert.doesNotMatch(workflow, /(?:checks|pull-requests|secrets):/)
  assert.match(workflow, /name: trusted pull request size/)
  assert.match(workflow, /steps:\s*\r?\n\s+- name: Publish pending status[\s\S]*?- name: Check out/)
  assert.match(workflow, /STATUS_CONTEXT: policy\/pull-request-size/)
  assert.match(workflow, /GITHUB_TOKEN: \$\{\{ github\.token \}\}/)
  assert.match(workflow, /statuses\/\$HEAD_SHA/)
  assert.match(workflow, /name: Publish final status\s*\r?\n\s+if: always\(\)/)
  assert.match(workflow, /JOB_STATUS: \$\{\{ job\.status \}\}/)
  assert.match(workflow, /actions\/setup-node@[0-9a-f]{40}[\s\S]*node-version: 22/)
  assert.match(workflow, /ref: \$\{\{ github\.event\.pull_request\.base\.sha \}\}[\s\S]*path: trusted-controller/)
  assert.match(workflow, /repository: \$\{\{ github\.event\.pull_request\.head\.repo\.full_name \}\}[\s\S]*ref: \$\{\{ github\.event\.pull_request\.head\.sha \}\}[\s\S]*path: candidate-diff/)
  assert.match(workflow, /working-directory: trusted-controller[\s\S]*run: npm ci --ignore-scripts/)
  assert.match(workflow, /working-directory: trusted-controller[\s\S]*run: node scripts\/check-pr-size\.mjs/)
  assert.match(workflow, /GIT_DIFF_REPOSITORY: \$\{\{ github\.workspace \}\}\/candidate-diff/)
  assert.match(gate, /GIT_DIFF_REPOSITORY/)
  assert.ok(workflow.split(/(?=^\s{6}- name:)/m).filter(step => step.includes('working-directory: candidate-diff')).every(step => !/\brun:\s*(?:npm|node)\b/.test(step)))
  assert.doesNotMatch(controllerCi, /pull-request-scope|check-pr-size\.mjs/)
  assert.match(controllerCi, /needs: \[test\]/)
})
