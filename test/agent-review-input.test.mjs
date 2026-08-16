import assert from 'node:assert/strict'
import { readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { prepareAgentReviewInput } from '../src/agent-review-input.mjs'

const base = 'a'.repeat(40)
const head = 'b'.repeat(40)

test('review input binds the exact pair and reads guidance only from the base tree', async () => {
  const calls = []
  const signal = new AbortController().signal
  const runCommand = async (executable, args, options) => {
    calls.push({ executable, args, options })
    const command = args.slice(2)
    if (command[0] === 'diff') return { stdout: 'diff --git a/x b/x\n+added\n' }
    if (command[0] === 'ls-tree') return { stdout: 'AGENTS.md\r\npackages/a/AGENTS.md\r\nREADME.md\r\n' }
    if (command[0] === 'show') return { stdout: `guidance:${command[1]}` }
    throw new Error(`Unexpected git command ${command.join(' ')}`)
  }

  const result = await prepareAgentReviewInput({
    checkout: 'F:\\review',
    taskId: `review-${base}-${head}`,
    gitExecutable: 'git.exe',
    runCommand,
    environment: { SAFE: '1' },
    timeoutMs: 1234,
    signal,
    directoryPrefix: 'agent-review-input-test-',
  })
  try {
    const payload = JSON.parse(await readFile(path.join(result.projectDirectory, 'review-input.json'), 'utf8'))
    assert.deepEqual(payload, {
      version: 1,
      base,
      head,
      diff: 'diff --git a/x b/x\n+added\n',
      guidance: {
        'AGENTS.md': `guidance:${base}:AGENTS.md`,
        'packages/a/AGENTS.md': `guidance:${base}:packages/a/AGENTS.md`,
      },
    })
    assert.deepEqual(calls.map(call => call.args.slice(2)), [
      ['diff', '--no-ext-diff', '--no-textconv', '--find-renames', `${base}...${head}`],
      ['ls-tree', '-r', '--name-only', base],
      ['show', `${base}:AGENTS.md`],
      ['show', `${base}:packages/a/AGENTS.md`],
    ])
    assert.ok(calls.every(call => call.executable === 'git.exe'
      && call.options.timeoutMs === 1234
      && call.options.signal === signal
      && call.options.env.SAFE === '1'))
  } finally {
    await rm(result.projectDirectory, { recursive: true, force: true })
  }
})

test('review input rejects a task id that does not bind lowercase full SHAs before git runs', async () => {
  let called = false
  await assert.rejects(prepareAgentReviewInput({
    checkout: 'F:\\review',
    taskId: `review-${base.toUpperCase()}-${head}`,
    gitExecutable: 'git.exe',
    runCommand: async () => { called = true },
    environment: {},
    timeoutMs: 1,
    directoryPrefix: 'agent-review-input-test-',
  }), /lowercase full base and head SHA/)
  assert.equal(called, false)
})

test('review input propagates a git failure without creating a task directory', async () => {
  await assert.rejects(prepareAgentReviewInput({
    checkout: 'F:\\review',
    taskId: `review-${base}-${head}`,
    gitExecutable: 'git.exe',
    runCommand: async () => { throw new Error('verified diff unavailable') },
    environment: {},
    timeoutMs: 1,
    directoryPrefix: 'agent-review-input-test-',
  }), /verified diff unavailable/)
})
