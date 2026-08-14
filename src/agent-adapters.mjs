import path from 'node:path'
import { mkdtemp, rm } from 'node:fs/promises'
import {
  hostCredentialEnvironment,
  parseJson,
  reviewerCredentialEnvironment,
  run,
} from './common.mjs'
import { runReviewTask } from './codex-session.mjs'
import { dshRpc, runDshWebSession } from './dsh-web-session.mjs'

/** Build the machine-local adapter registry used by the Agent Worker module. */
export function createAgentAdapters({
  runCommand = run,
  runDshSession = runDshWebSession,
  runCodexTask = runReviewTask,
  callDsh = dshRpc,
} = {}) {
  return {
    'dsh-web': {
      run: async ({ worker, invocation }) => {
        const result = await runDshSession({
          baseUrl: worker.baseUrl,
          cwd: invocation.cwd,
          title: invocation.title,
          prompt: invocation.prompt,
          timeoutMs: invocation.timeoutMs,
          signal: invocation.signal,
          onCreated: invocation.onStarted,
        })
        return {
          sessionId: result.sessionId,
          outcome: result.reason === 'completed' ? 'completed' : 'failed',
          detail: result.reason || '',
        }
      },
      health: async ({ worker }) => {
        const sessions = await callDsh(worker.baseUrl, 'session.list', {})
        const active = (sessions.items || []).filter(session => session.running).length
        return { detail: `DSH Web Host reachable; ${active} active visible session(s)` }
      },
    },
    'codex-app': {
      run: async ({ worker, invocation }) => {
        const credentialIsolationDir = worker.credentialIsolationDir
          || path.join(worker.home, '.dsh-agent-automation', 'reviewer-gh')
        const taskCwd = await mkdtemp(path.join(path.dirname(invocation.cwd), 'codex-review-context-'))
        try {
          const result = await runCodexTask({
            node: worker.node,
            codexScript: worker.script,
            prompt: invocation.prompt,
            title: invocation.title,
            projectCwd: worker.projectCwd || taskCwd,
            taskCwd,
            reviewCwd: invocation.cwd,
            environment: reviewerCredentialEnvironment({
              CODEX_HOME: worker.home,
              GH_CONFIG_DIR: credentialIsolationDir,
              NO_COLOR: '1',
            }),
            model: worker.model,
            effort: worker.effort,
            keep: worker.keep,
            timeoutMs: invocation.timeoutMs,
            signal: invocation.signal,
            onCreated: invocation.onStarted,
          })
          return {
            sessionId: result.threadId,
            outcome: 'completed',
            detail: '',
            output: result.finalMessage,
          }
        } finally {
          await rm(taskCwd, { recursive: true, force: true })
        }
      },
      health: async ({ worker }) => {
        const credentialIsolationDir = worker.credentialIsolationDir
          || path.join(worker.home, '.dsh-agent-automation', 'reviewer-gh')
        const result = await runCommand(worker.node, [worker.script, '--version'], {
          env: reviewerCredentialEnvironment({
            CODEX_HOME: worker.home,
            GH_CONFIG_DIR: credentialIsolationDir,
            NO_COLOR: '1',
          }),
        })
        return { detail: result.stdout.trim() }
      },
    },
    'command-json': {
      run: async ({ worker, invocation }) => {
        validateCommandWorker(worker)
        const result = await runCommand(worker.executable, worker.args || [], {
          cwd: invocation.cwd,
          env: hostCredentialEnvironment(),
          input: JSON.stringify(invocation),
          timeoutMs: invocation.timeoutMs,
        })
        return parseJson(result.stdout, 'command-json worker receipt')
      },
      health: async ({ worker }) => {
        validateCommandWorker(worker)
        if (!Array.isArray(worker.healthArgs)) throw new Error('command-json worker must declare healthArgs')
        const result = await runCommand(worker.executable, worker.healthArgs, {
          env: hostCredentialEnvironment(),
        })
        return { detail: result.stdout.trim() }
      },
    },
  }
}

function validateCommandWorker(worker) {
  if (typeof worker.executable !== 'string' || !worker.executable.trim()) {
    throw new Error('command-json worker executable must be a non-empty string')
  }
  for (const field of ['args', 'healthArgs']) {
    if (worker[field] !== undefined
      && (!Array.isArray(worker[field]) || !worker[field].every(value => typeof value === 'string'))) {
      throw new Error(`command-json worker ${field} must be an array of strings`)
    }
  }
}
