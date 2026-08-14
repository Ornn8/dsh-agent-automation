import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { checkAgentWorker, normalizeWorkerConfig, runAgentWorker } from '../src/agent-worker.mjs'
import { createAgentAdapters } from '../src/agent-adapters.mjs'

test('a controller invokes any configured worker through one interface', async () => {
  const invocations = []
  const receipt = await runAgentWorker({
    config: {
      workers: {
        reviewer: { adapter: 'fake', runnerLabels: ['self-hosted', 'reviewer'] },
      },
    },
    workerId: 'reviewer',
    invocation: {
      taskId: 'pr-12-base-head',
      cwd: 'F:\\checkout',
      title: 'Review PR #12',
      prompt: 'Review the exact pair.',
      timeoutMs: 60_000,
    },
    adapters: {
      fake: async input => {
        invocations.push(input)
        return { sessionId: 'review-session', outcome: 'completed', output: 'PASS' }
      },
    },
  })

  assert.equal(invocations[0].workerId, 'reviewer')
  assert.equal(invocations[0].invocation.taskId, 'pr-12-base-head')
  assert.deepEqual(receipt, {
    workerId: 'reviewer',
    sessionId: 'review-session',
    outcome: 'completed',
    detail: '',
    output: 'PASS',
  })
})

test('worker configuration accepts arbitrary adapters and migrates current DSH and Codex settings', () => {
  const explicit = normalizeWorkerConfig({
    workers: {
      luna: { adapter: 'command-json', executable: 'luna.exe' },
    },
  })
  assert.equal(explicit.workers.luna.adapter, 'command-json')

  const migrated = normalizeWorkerConfig({
    dshWebBaseUrl: 'http://localhost:3080',
    codexNode: 'node.exe',
    codexScript: 'codex.js',
    codexHome: 'F:\\CodexData',
    codexProjectCwd: 'F:\\repo',
  })
  assert.equal(migrated.workers.dsh.adapter, 'dsh-web')
  assert.equal(migrated.workers.codex.adapter, 'codex-app')
})

test('a command-json adapter lets a new agent join without controller changes', async () => {
  const calls = []
  const adapters = createAgentAdapters({
    runCommand: async (command, args, options) => {
      calls.push({ command, args, options })
      return {
        stdout: JSON.stringify({
          sessionId: 'luna-42', outcome: 'completed', detail: 'done', output: 'result',
        }),
      }
    },
  })
  const receipt = await runAgentWorker({
    config: {
      workers: {
        luna: {
          adapter: 'command-json',
          executable: 'F:\\agents\\luna.exe',
          args: ['run-json'],
        },
      },
    },
    workerId: 'luna',
    invocation: {
      taskId: 'issue-42', cwd: 'F:\\checkout', title: 'Issue 42',
      prompt: 'Implement the issue.', timeoutMs: 90_000,
    },
    adapters,
  })

  assert.equal(calls[0].command, 'F:\\agents\\luna.exe')
  assert.deepEqual(calls[0].args, ['run-json'])
  assert.equal(JSON.parse(calls[0].options.input).taskId, 'issue-42')
  assert.equal(receipt.sessionId, 'luna-42')
  assert.equal(receipt.output, 'result')
})

test('the DSH Web adapter satisfies the same worker interface', async () => {
  const calls = []
  const started = []
  const adapters = createAgentAdapters({
    runDshSession: async input => {
      calls.push(input)
      await input.onCreated({ sessionId: 'dsh-visible' })
      return { sessionId: 'dsh-visible', reason: 'completed' }
    },
  })
  const receipt = await runAgentWorker({
    config: { workers: { implementer: {
      adapter: 'dsh-web', baseUrl: 'http://localhost:3080', provider: 'opencode-go', model: 'deepseek-v4-flash', reasoningEffort: 'max',
    } } },
    workerId: 'implementer',
    invocation: {
      taskId: 'issue-7', cwd: 'F:\\checkout', title: 'Issue 7',
      prompt: 'Implement issue 7.', timeoutMs: 120_000,
      onStarted: value => started.push(value),
    },
    adapters,
  })

  assert.equal(calls[0].baseUrl, 'http://localhost:3080')
  assert.deepEqual(calls[0].modelSelection, { provider: 'opencode-go', model: 'deepseek-v4-flash', reasoningEffort: 'max' })
  assert.deepEqual(started, [{ sessionId: 'dsh-visible' }])
  assert.equal(receipt.workerId, 'implementer')
  assert.equal(receipt.outcome, 'completed')
})

test('the Codex adapter satisfies the worker interface without GitHub credentials', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-agent-worker-'))
  const checkout = path.join(root, 'checkout')
  const home = path.join(root, 'codex-home')
  const project = path.join(root, 'project')
  await mkdir(checkout)
  const calls = []
  const adapters = createAgentAdapters({
    runCodexTask: async input => {
      calls.push(input)
      await input.onCreated({ sessionId: 'codex-thread' })
      return { threadId: 'codex-thread', finalMessage: 'PASS' }
    },
  })
  try {
    const receipt = await runAgentWorker({
      config: { workers: { reviewer: {
        adapter: 'codex-app', node: 'node.exe', script: 'codex.js',
        home, projectCwd: project,
        model: 'gpt-5.6-sol', effort: 'medium', keep: 6,
      } } },
      workerId: 'reviewer',
      invocation: {
        taskId: 'review-pair', cwd: checkout, title: 'Review pair',
        prompt: 'Review it.', timeoutMs: 60_000,
      },
      adapters,
    })

    assert.equal(calls[0].model, 'gpt-5.6-sol')
    assert.equal(calls[0].effort, 'medium')
    assert.equal(calls[0].projectCwd, project)
    assert.equal(calls[0].reviewCwd, checkout)
    assert.notEqual(calls[0].taskCwd, calls[0].reviewCwd)
    assert.equal(calls[0].taskCwd.startsWith(path.join(root, 'codex-review-context-')), true)
    assert.equal(calls[0].environment.GITHUB_TOKEN, undefined)
    assert.equal(calls[0].environment.GH_TOKEN, undefined)
    assert.equal(calls[0].environment.DEEPSEEK_API_KEY, undefined)
    assert.equal(calls[0].environment.GH_CONFIG_DIR, path.join(home, '.dsh-agent-automation', 'reviewer-gh'))
    assert.equal(calls[0].environment.GIT_CONFIG_GLOBAL, process.platform === 'win32' ? 'NUL' : '/dev/null')
    assert.equal(receipt.sessionId, 'codex-thread')
    assert.equal(receipt.output, 'PASS')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('worker receipts fail closed unless they end at a declared terminal outcome', async () => {
  await assert.rejects(runAgentWorker({
    config: { workers: { reviewer: { adapter: 'fake' } } },
    workerId: 'reviewer',
    invocation: {
      taskId: 'review-pair', cwd: 'F:\\checkout', title: 'Review pair',
      prompt: 'Review it.', timeoutMs: 60_000,
    },
    adapters: {
      fake: async () => ({ sessionId: 'thread', outcome: 'still-running' }),
    },
  }), /Unknown worker receipt outcome/)
})

test('worker health is adapter-specific and makes no task invocation', async () => {
  const calls = []
  const result = await checkAgentWorker({
    config: { workers: { reviewer: { adapter: 'fake' } } },
    workerId: 'reviewer',
    adapters: {
      fake: {
        run: async () => { throw new Error('must not run') },
        health: async input => {
          calls.push(input)
          return { detail: 'ready' }
        },
      },
    },
  })
  assert.equal(calls[0].workerId, 'reviewer')
  assert.deepEqual(result, { workerId: 'reviewer', detail: 'ready' })
})

test('a worker passes controller cancellation through its adapter invocation', async () => {
  const controller = new AbortController()
  let received
  await runAgentWorker({
    config: { workers: { dsh: { adapter: 'fake' } } }, workerId: 'dsh',
    invocation: { taskId: 'cancel', cwd: 'F:\\checkout', title: 'Cancel', prompt: 'Stop.', timeoutMs: 1, signal: controller.signal },
    adapters: { fake: async ({ invocation }) => {
      received = invocation.signal
      return { sessionId: 'session', outcome: 'failed' }
    } },
  })
  assert.equal(received, controller.signal)
})
