import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { checkAgentWorker, normalizeWorkerConfig, runAgentWorker } from '../src/agent-worker.mjs'
import { createAgentAdapters } from '../src/agent-adapters.mjs'
import { parseClaudeCodeOutput } from '../src/claude-code-cli.mjs'
import { parseOpenCodeRunOutput } from '../src/opencode-cli.mjs'

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
    worker: { id: 'reviewer', adapter: 'fake', displayName: 'fake' },
    sessionId: 'review-session',
    outcome: 'completed',
    detail: '',
    output: 'PASS',
  })
})

test('worker configuration accepts explicit adapters and rejects removed legacy fields', () => {
  const explicit = normalizeWorkerConfig({
    workers: {
      luna: { adapter: 'command-json', executable: 'luna.exe' },
    },
  })
  assert.equal(explicit.workers.luna.adapter, 'command-json')

  assert.throws(() => normalizeWorkerConfig({
    dshWebBaseUrl: 'http://localhost:3080',
    codexNode: 'node.exe',
    codexScript: 'codex.js',
    codexHome: 'F:\\CodexData',
    codexProjectCwd: 'F:\\repo',
  }), /must declare workers/)
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
          mode: 'change',
        },
      },
    },
    workerId: 'luna',
    invocation: {
      taskId: 'issue-42', cwd: 'F:\\checkout', title: 'Issue 42',
      prompt: 'Implement the issue.', timeoutMs: 90_000, signal: new AbortController().signal,
    },
    adapters,
  })

  assert.equal(calls[0].command, 'F:\\agents\\luna.exe')
  assert.deepEqual(calls[0].args, ['run-json'])
  assert.equal(JSON.parse(calls[0].options.input).taskId, 'issue-42')
  assert.equal(calls[0].options.signal.aborted, false)
  assert.equal(receipt.sessionId, 'luna-42')
  assert.equal(receipt.output, 'result')
})

test('the Claude Code CLI adapter runs change work through the shared worker interface', async () => {
  const calls = []
  const started = []
  let mountedSkill
  let pluginDirectory
  const finalMessage = '完成。\n<!-- agent-automation-result\n{"version":1,"outcome":"completed","summary":"已提交 PR。"}\n-->'
  const adapters = createAgentAdapters({
    runCommand: async (command, args, options) => {
      calls.push({ command, args, options })
      pluginDirectory = args[args.indexOf('--plugin-dir') + 1]
      mountedSkill = await readFile(path.join(
        pluginDirectory, 'skills', 'github-issue-work', 'SKILL.md',
      ), 'utf8')
      const firstEvent = JSON.stringify({ type: 'system', subtype: 'init', session_id: 'claude-change' })
      options.onStdout(`${firstEvent}\n`)
      assert.deepEqual(started, [{ sessionId: 'claude-change' }])
      return {
        stdout: [
          firstEvent,
          JSON.stringify({
            type: 'result', subtype: 'success', is_error: false,
            session_id: 'claude-change', result: finalMessage,
          }),
        ].join('\n'),
        stderr: '',
      }
    },
  })

  const receipt = await runAgentWorker({
    config: { workers: { claude: {
      adapter: 'claude-code-cli', executable: 'claude.exe', mode: 'change',
      model: 'opus', effort: 'max',
    } } },
    workerId: 'claude',
    invocation: {
      taskId: 'issue-repo-42-request', cwd: 'F:\\checkout', title: 'Issue 42',
      prompt: '/github-issue-work {"repository":"owner/repo","issueNumber":42}',
      requiredSkill: 'github-issue-work', timeoutMs: 90_000,
      onStarted: value => started.push(value),
    },
    adapters,
  })

  assert.equal(calls[0].command, 'claude.exe')
  assert.equal(calls[0].args.includes('--permission-mode'), true)
  assert.equal(calls[0].args.includes('bypassPermissions'), true)
  assert.equal(calls[0].args.includes('opus'), true)
  assert.equal(calls[0].args.includes('max'), true)
  assert.equal(calls[0].options.cwd, 'F:\\checkout')
  assert.match(calls[0].options.input, /^\/dsh-github-work:github-issue-work /)
  assert.match(mountedSkill, /^---\nname: github-issue-work\n/)
  await assert.rejects(access(pluginDirectory))
  assert.deepEqual(started, [{ sessionId: 'claude-change' }])
  assert.equal(receipt.sessionId, 'claude-change')
  assert.equal(receipt.outcome, 'completed')
  assert.equal(receipt.detail, '已提交 PR。')
  assert.equal(receipt.output, finalMessage)
})

test('the Claude Code CLI adapter isolates untrusted review work from credentials and writes', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-claude-review-test-'))
  const checkout = path.join(root, 'checkout')
  await mkdir(checkout)
  const base = '3'.repeat(40)
  const head = '4'.repeat(40)
  let claudeCall
  let reviewBundle
  let reviewSkill
  const adapters = createAgentAdapters({
    runCommand: async (command, args, options) => {
      if (command === 'git.exe') {
        if (args.includes('diff')) return { stdout: 'diff --git a/src/b.js b/src/b.js\n+review me\n', stderr: '' }
        if (args.includes('ls-tree')) return { stdout: 'AGENTS.md\nsrc/AGENTS.md\nsrc/b.js\n', stderr: '' }
        if (args.includes('show')) return { stdout: `trusted guidance for ${args.at(-1)}\n`, stderr: '' }
        throw new Error(`Unexpected git invocation: ${args.join(' ')}`)
      }
      claudeCall = { command, args, options }
      reviewBundle = JSON.parse(await readFile(path.join(options.cwd, 'review-input.json'), 'utf8'))
      reviewSkill = await readFile(args[args.indexOf('--append-system-prompt-file') + 1], 'utf8')
      const firstEvent = JSON.stringify({ type: 'system', subtype: 'init', session_id: 'claude-review' })
      options.onStdout(`${firstEvent}\n`)
      return {
        stdout: [
          firstEvent,
          JSON.stringify({
            type: 'result', subtype: 'success', is_error: false,
            session_id: 'claude-review', result: 'VERDICT: PASS',
          }),
        ].join('\n'),
        stderr: '',
      }
    },
  })
  try {
    const receipt = await runAgentWorker({
      config: { workers: { reviewer: {
        adapter: 'claude-code-cli', executable: 'claude.exe', gitExecutable: 'git.exe',
        mode: 'review', model: 'sonnet', effort: 'high',
      } } },
      workerId: 'reviewer',
      invocation: {
        taskId: `review-${base}-${head}`, cwd: checkout, title: 'Review PR #42',
        prompt: 'Review this exact pull request pair.', requiredSkill: 'github-pr-review',
        timeoutMs: 60_000,
      },
      adapters,
    })

    assert.equal(claudeCall.command, 'claude.exe')
    assert.notEqual(claudeCall.options.cwd, checkout)
    assert.equal(claudeCall.args.includes('--setting-sources'), true)
    assert.equal(claudeCall.args.includes('project'), true)
    assert.equal(claudeCall.args.includes('--disable-slash-commands'), true)
    assert.equal(claudeCall.args.includes('dontAsk'), true)
    assert.equal(claudeCall.args.includes('Read,Glob,Grep'), true)
    assert.equal(claudeCall.args.includes('mcp__*'), true)
    assert.equal(claudeCall.args.includes('--strict-mcp-config'), true)
    assert.equal(claudeCall.args.includes('{"mcpServers":{}}'), true)
    assert.equal(claudeCall.args.includes(checkout), true)
    assert.equal(claudeCall.options.env.GH_TOKEN, undefined)
    assert.equal(claudeCall.options.env.GITHUB_TOKEN, undefined)
    assert.equal(claudeCall.options.env.ANTHROPIC_API_KEY, undefined)
    assert.equal(claudeCall.options.env.DEEPSEEK_API_KEY, undefined)
    assert.equal(claudeCall.options.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY, '1')
    assert.equal(claudeCall.options.env.CLAUDE_CODE_DISABLE_CLAUDE_MDS, '1')
    assert.equal(claudeCall.options.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, '1')
    assert.deepEqual(reviewBundle, {
      version: 1,
      base,
      head,
      diff: 'diff --git a/src/b.js b/src/b.js\n+review me\n',
      guidance: {
        'AGENTS.md': `trusted guidance for ${base}:AGENTS.md\n`,
        'src/AGENTS.md': `trusted guidance for ${base}:src/AGENTS.md\n`,
      },
    })
    assert.match(reviewSkill, /^The trusted controller invokes this Skill/)
    assert.equal(receipt.sessionId, 'claude-review')
    assert.equal(receipt.output, 'VERDICT: PASS')
    await assert.rejects(access(claudeCall.options.cwd))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('Claude Code JSON output fails closed on malformed, failed, duplicate, or mixed sessions', () => {
  assert.throws(() => parseClaudeCodeOutput('not-json'), /not valid JSON/)
  assert.throws(() => parseClaudeCodeOutput([
    JSON.stringify({ type: 'system', session_id: 'one' }),
    JSON.stringify({ type: 'result', subtype: 'success', is_error: false, session_id: 'two', result: 'done' }),
  ].join('\n')), /exactly one session_id/)
  assert.throws(() => parseClaudeCodeOutput(JSON.stringify({
    type: 'result', subtype: 'error_max_turns', is_error: true,
    session_id: 'one', result: 'stopped',
  })), /session failed/)
  assert.throws(() => parseClaudeCodeOutput([
    JSON.stringify({ type: 'result', subtype: 'success', is_error: false, session_id: 'one', result: 'one' }),
    JSON.stringify({ type: 'result', subtype: 'success', is_error: false, session_id: 'one', result: 'two' }),
  ].join('\n')), /exactly one result/)
})

test('the OpenCode CLI adapter runs change work through the shared worker interface', async () => {
  const calls = []
  const started = []
  let mountedSkill
  let mountedConfigDirectory
  const finalMessage = '完成。\n<!-- agent-automation-result\n{"version":1,"outcome":"completed","summary":"已提交 PR。"}\n-->'
  const adapters = createAgentAdapters({
    runCommand: async (command, args, options) => {
      calls.push({ command, args, options })
      mountedConfigDirectory = options.env.OPENCODE_CONFIG_DIR
      mountedSkill = await readFile(path.join(
        mountedConfigDirectory, 'skills', 'github-issue-work', 'SKILL.md',
      ), 'utf8')
      const firstEvent = JSON.stringify({ type: 'step_start', sessionID: 'ses_change', part: { type: 'step-start' } })
      options.onStdout(`${firstEvent}\n`)
      assert.deepEqual(started, [{ sessionId: 'ses_change' }])
      return {
        stdout: [
          firstEvent,
          JSON.stringify({ type: 'text', sessionID: 'ses_change', part: { type: 'text', messageID: 'msg_final', text: finalMessage } }),
          JSON.stringify({ type: 'step_finish', sessionID: 'ses_change', part: { type: 'step-finish' } }),
        ].join('\n'),
        stderr: '',
      }
    },
  })

  const receipt = await runAgentWorker({
    config: { workers: { opencode: {
      adapter: 'opencode-cli', executable: 'F:\\agents\\opencode.exe', mode: 'change',
      model: 'opencode/deepseek-v4', variant: 'max',
    } } },
    workerId: 'opencode',
    invocation: {
      taskId: 'issue-repo-42-request', cwd: 'F:\\checkout', title: 'Issue 42',
      prompt: '/github-issue-work {"repository":"owner/repo","issueNumber":42}',
      requiredSkill: 'github-issue-work', timeoutMs: 90_000,
      onStarted: value => started.push(value),
    },
    adapters,
  })

  assert.equal(calls[0].command, 'F:\\agents\\opencode.exe')
  assert.deepEqual(calls[0].args.slice(0, 5), ['run', '--format', 'json', '--auto', '--model'])
  assert.equal(calls[0].args.includes('opencode/deepseek-v4'), true)
  assert.equal(calls[0].args.includes('max'), true)
  assert.equal(calls[0].options.cwd, 'F:\\checkout')
  assert.match(calls[0].options.input, /Use the github-issue-work skill/)
  assert.match(mountedSkill, /^---\nname: github-issue-work\n/)
  await assert.rejects(access(mountedConfigDirectory))
  assert.deepEqual(started, [{ sessionId: 'ses_change' }])
  assert.equal(receipt.sessionId, 'ses_change')
  assert.equal(receipt.outcome, 'completed')
  assert.equal(receipt.detail, '已提交 PR。')
  assert.equal(receipt.output, finalMessage)
})

test('the OpenCode CLI adapter isolates untrusted review work from credentials and writes', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-opencode-review-test-'))
  const checkout = path.join(root, 'checkout')
  await mkdir(checkout)
  const base = '1'.repeat(40)
  const head = '2'.repeat(40)
  let opencodeCall
  let reviewBundle
  let reviewConfig
  let mountedSkill
  const adapters = createAgentAdapters({
    runCommand: async (command, args, options) => {
      if (command === 'git.exe') {
        if (args.includes('diff')) return { stdout: 'diff --git a/src/a.js b/src/a.js\n+new behavior\n', stderr: '' }
        if (args.includes('ls-tree')) return { stdout: 'AGENTS.md\nsrc/AGENTS.md\nsrc/a.js\n', stderr: '' }
        if (args.includes('show')) return { stdout: `trusted guidance for ${args.at(-1)}\n`, stderr: '' }
        throw new Error(`Unexpected git invocation: ${args.join(' ')}`)
      }
      opencodeCall = { command, args, options }
      reviewBundle = JSON.parse(await readFile(path.join(options.cwd, 'review-input.json'), 'utf8'))
      reviewConfig = JSON.parse(options.env.OPENCODE_CONFIG_CONTENT)
      mountedSkill = await readFile(path.join(
        options.env.OPENCODE_CONFIG_DIR, 'skills', 'github-pr-review', 'SKILL.md',
      ), 'utf8')
      return {
        stdout: JSON.stringify({
          type: 'text', sessionID: 'ses_review',
          part: { type: 'text', messageID: 'msg_review', text: 'VERDICT: PASS' },
        }),
        stderr: '',
      }
    },
  })
  try {
    const receipt = await runAgentWorker({
      config: { workers: { reviewer: {
        adapter: 'opencode-cli', executable: 'opencode.exe', gitExecutable: 'git.exe',
        mode: 'review', model: 'openai/gpt-5', variant: 'medium',
      } } },
      workerId: 'reviewer',
      invocation: {
        taskId: `review-${base}-${head}`, cwd: checkout, title: 'Review PR #42',
        prompt: 'Review this exact pull request pair.', requiredSkill: 'github-pr-review',
        timeoutMs: 60_000,
      },
      adapters,
    })

    assert.equal(opencodeCall.command, 'opencode.exe')
    assert.deepEqual(opencodeCall.args.slice(0, 2), ['--pure', 'run'])
    assert.notEqual(opencodeCall.options.cwd, checkout)
    assert.equal(opencodeCall.options.env.GH_TOKEN, undefined)
    assert.equal(opencodeCall.options.env.GITHUB_TOKEN, undefined)
    assert.equal(opencodeCall.options.env.DEEPSEEK_API_KEY, undefined)
    assert.equal(opencodeCall.options.env.OPENCODE_DISABLE_DEFAULT_PLUGINS, 'true')
    assert.equal(reviewConfig.agent['controller-review'].permission.edit, 'deny')
    assert.equal(reviewConfig.agent['controller-review'].permission.bash, 'deny')
    assert.equal(reviewConfig.agent['controller-review'].permission.external_directory['*'], 'deny')
    assert.equal(reviewConfig.agent['controller-review'].permission.external_directory[path.join(checkout, '**')], 'allow')
    assert.deepEqual(reviewBundle, {
      version: 1,
      base,
      head,
      diff: 'diff --git a/src/a.js b/src/a.js\n+new behavior\n',
      guidance: {
        'AGENTS.md': `trusted guidance for ${base}:AGENTS.md\n`,
        'src/AGENTS.md': `trusted guidance for ${base}:src/AGENTS.md\n`,
      },
    })
    assert.match(mountedSkill, /^---\nname: github-pr-review\n/)
    assert.equal(receipt.sessionId, 'ses_review')
    assert.equal(receipt.output, 'VERDICT: PASS')
    await assert.rejects(access(opencodeCall.options.cwd))
    await assert.rejects(access(opencodeCall.options.env.OPENCODE_CONFIG_DIR))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('OpenCode JSON output fails closed on malformed, failed, or mixed sessions', () => {
  assert.throws(() => parseOpenCodeRunOutput('not-json'), /not valid JSON/)
  assert.throws(() => parseOpenCodeRunOutput([
    JSON.stringify({ type: 'text', sessionID: 'one', part: { messageID: 'm1', text: 'one' } }),
    JSON.stringify({ type: 'text', sessionID: 'two', part: { messageID: 'm2', text: 'two' } }),
  ].join('\n')), /exactly one sessionID/)
  assert.throws(() => parseOpenCodeRunOutput([
    JSON.stringify({ type: 'error', sessionID: 'one', error: { name: 'ProviderError' } }),
  ].join('\n')), /session failed/)
})

test('the DSH Web adapter satisfies the same worker interface', async () => {
  const calls = []
  const started = []
  const adapters = createAgentAdapters({
    runDshSession: async input => {
      calls.push(input)
      await input.onCreated({ sessionId: 'dsh-visible' })
      return {
        sessionId: 'dsh-visible',
        reason: 'completed',
        finalMessage: '完成。\n<!-- agent-automation-result\n{"version":1,"outcome":"completed","summary":"完成"}\n-->',
        automationResult: { version: 1, outcome: 'completed', summary: '完成' },
      }
    },
  })
  const receipt = await runAgentWorker({
    config: { workers: { implementer: {
      adapter: 'dsh-web', baseUrl: 'http://localhost:3080', agentPreset: 'standard', permissionPreset: 'danger-full-access',
      provider: 'opencode-go', model: 'deepseek-v4-flash', reasoningEffort: 'max',
    } } },
    workerId: 'implementer',
    invocation: {
      taskId: 'issue-7', cwd: 'F:\\checkout', title: 'Issue 7',
      prompt: 'Implement issue 7.', timeoutMs: 120_000,
      requiredSkill: 'github-issue-work',
      onStarted: value => started.push(value),
    },
    adapters,
  })

  assert.equal(calls[0].baseUrl, 'http://localhost:3080')
  assert.equal(calls[0].taskId, 'issue-7')
  assert.deepEqual(calls[0].modelSelection, { provider: 'opencode-go', model: 'deepseek-v4-flash', reasoningEffort: 'max' })
  assert.equal(calls[0].agentPreset, 'standard')
  assert.equal(calls[0].permissionPreset, 'danger-full-access')
  assert.equal(calls[0].requiredSkill, 'github-issue-work')
  assert.deepEqual(started, [{ sessionId: 'dsh-visible' }])
  assert.equal(receipt.workerId, 'implementer')
  assert.equal(receipt.outcome, 'completed')
  assert.equal(receipt.detail, '完成')
  assert.equal(receipt.automationResult.outcome, 'completed')
})

test('the DSH Web adapter can perform review without a change-work receipt', async () => {
  const calls = []
  const adapters = createAgentAdapters({
    runDshSession: async input => {
      calls.push(input)
      return { sessionId: 'dsh-review', reason: 'completed', finalMessage: 'VERDICT: PASS' }
    },
  })
  const receipt = await runAgentWorker({
    config: { workers: { reviewer: {
      adapter: 'dsh-web', baseUrl: 'http://localhost:3080', agentPreset: 'standard', permissionPreset: 'read-only', provider: 'opencode-go',
      model: 'deepseek-v4-flash', reasoningEffort: 'max',
    } } },
    workerId: 'reviewer',
    invocation: {
      taskId: `review-${'1'.repeat(40)}-${'2'.repeat(40)}`,
      cwd: 'F:\\checkout', title: 'Review PR #42', prompt: 'Review it.',
      requiredSkill: 'github-pr-review', timeoutMs: 60_000,
    },
    adapters,
  })

  assert.equal(calls[0].requiresAutomationResult, false)
  assert.equal(receipt.outcome, 'completed')
  assert.equal(receipt.output, 'VERDICT: PASS')
  assert.equal(receipt.automationResult, undefined)
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
    assert.deepEqual(receipt.worker, {
      id: 'reviewer', adapter: 'codex-app', model: 'gpt-5.6-sol', reasoning: 'medium',
      displayName: 'codex-app gpt-5.6-sol (medium)',
    })
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
