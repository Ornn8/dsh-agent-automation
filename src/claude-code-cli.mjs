import path from 'node:path'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { AGENT_READINESS_SKILL, AGENT_REVIEW_SKILL, AGENT_SUPERVISION_SKILL, agentSkillDefinition, parseAgentAutomationResult } from './agent-work-result.mjs'
import { prepareAgentReviewInput } from './agent-review-input.mjs'

const PLUGIN_NAME = 'dsh-github-work'

function requiredText(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} must be a non-empty string`)
  return value.trim()
}

/** Parse one completed Claude Code stream into its terminal assistant message. */
export function parseClaudeCodeOutput(stdout) {
  const events = String(stdout || '').split(/\r?\n/).filter(line => line.trim()).map((line, index) => {
    try {
      return JSON.parse(line)
    } catch (error) {
      throw new Error(`Claude Code output line ${index + 1} is not valid JSON: ${error.message}`, { cause: error })
    }
  })
  if (events.length === 0) throw new Error('Claude Code produced no JSON events')
  const sessionIds = new Set(events.map(event => event?.session_id).filter(Boolean))
  if (sessionIds.size !== 1) throw new Error('Claude Code output must contain exactly one session_id')
  const results = events.filter(event => event?.type === 'result')
  if (results.length !== 1) throw new Error('Claude Code output must contain exactly one result event')
  const result = results[0]
  if (result.is_error || result.subtype !== 'success') {
    throw new Error(`Claude Code session failed: ${JSON.stringify(result)}`)
  }
  if (typeof result.result !== 'string' || !result.result.trim()) {
    throw new Error('Claude Code completed without a terminal assistant message')
  }
  return { sessionId: [...sessionIds][0], finalMessage: result.result }
}

function observeClaudeCodeSession(onStarted) {
  let buffer = ''
  let started
  return {
    feed(text) {
      if (started) return
      buffer += text
      const lines = buffer.split(/\r?\n/)
      buffer = lines.pop() || ''
      for (const line of lines) {
        try {
          const sessionId = JSON.parse(line)?.session_id
          if (typeof sessionId === 'string' && sessionId) {
            started = Promise.resolve(onStarted({ sessionId }))
            return
          }
        } catch {
          // The completed strict parser owns malformed-output errors.
        }
      }
    },
    async finish(sessionId) {
      if (!started) started = Promise.resolve(onStarted({ sessionId }))
      await started
    },
  }
}

async function materializeClaudePlugin(skillName) {
  const skill = agentSkillDefinition(skillName)
  const pluginDirectory = await mkdtemp(path.join(tmpdir(), 'dsh-claude-plugin-'))
  try {
    const skillDirectory = path.join(pluginDirectory, 'skills', skillName)
    await mkdir(path.join(pluginDirectory, '.claude-plugin'), { recursive: true })
    await mkdir(skillDirectory, { recursive: true })
    await writeFile(path.join(pluginDirectory, '.claude-plugin', 'plugin.json'), JSON.stringify({
      name: PLUGIN_NAME,
      version: '1.0.0',
      description: 'Controller-owned GitHub automation Skills.',
    }, null, 2), 'utf8')
    const source = await readFile(skill.source, 'utf8')
    const frontmatter = `---\nname: ${skillName}\ndescription: ${skill.description}\n---\n\n`
    await writeFile(path.join(skillDirectory, 'SKILL.md'), `${frontmatter}${source}`, 'utf8')
    return pluginDirectory
  } catch (error) {
    await rm(pluginDirectory, { recursive: true, force: true })
    throw error
  }
}

/** Run one controller invocation through the official non-interactive Claude Code CLI. */
export async function runClaudeCodeCli({ worker, invocation, runCommand, environment }) {
  if (!['change', 'review'].includes(worker.mode)) {
    throw new Error('Claude Code CLI worker mode must be change or review')
  }
  const executable = requiredText(worker.executable, 'Claude Code executable')
  const model = requiredText(worker.model, 'Claude Code model')
  const effort = requiredText(worker.effort, 'Claude Code effort')
  const requiredSkill = requiredText(invocation.requiredSkill, 'Claude Code skill')
  const marker = `/${requiredSkill}`
  if (worker.mode === 'change' && !invocation.prompt.startsWith(`${marker} `)) {
    throw new Error(`Claude Code change prompt must invoke ${marker}`)
  }
  if (worker.mode === 'review' && ![AGENT_REVIEW_SKILL, AGENT_SUPERVISION_SKILL, AGENT_READINESS_SKILL].includes(requiredSkill)) {
    throw new Error(`Claude Code review does not implement ${requiredSkill}`)
  }
  const pluginDirectory = worker.mode === 'change'
    ? await materializeClaudePlugin(requiredSkill)
    : undefined
  let review
  try {
    if (worker.mode === 'review' && requiredSkill === AGENT_REVIEW_SKILL) {
      review = await prepareAgentReviewInput({
        checkout: invocation.cwd,
        taskId: invocation.taskId,
        gitExecutable: requiredText(worker.gitExecutable, 'Claude Code review git executable'),
        runCommand,
        environment,
        timeoutMs: invocation.timeoutMs,
        signal: invocation.signal,
        directoryPrefix: 'dsh-claude-review-',
      })
    }
    const sessionObserver = observeClaudeCodeSession(invocation.onStarted)
    const args = [
      '-p', '--output-format', 'stream-json', '--verbose',
      ...(worker.mode === 'review' ? [
        '--setting-sources', 'project', '--disable-slash-commands',
        '--permission-mode', 'dontAsk', '--tools', 'Read,Glob,Grep',
        '--disallowedTools', 'mcp__*', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
        '--add-dir', invocation.cwd,
        '--append-system-prompt-file', fileURLToPath(agentSkillDefinition(requiredSkill).source),
      ] : [
        '--permission-mode', 'bypassPermissions', '--plugin-dir', pluginDirectory,
      ]),
      '--model', model, '--effort', effort, '--name', invocation.title, '--no-chrome',
    ]
    const result = await runCommand(executable, args, {
      cwd: review?.projectDirectory || invocation.cwd,
      env: review ? {
        ...environment,
        CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
        CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1',
        CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS: '1',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL: '1',
        CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '1',
      } : environment,
      input: worker.mode === 'review'
        ? `${review ? `The trusted review input is review-input.json. The exact head checkout is ${invocation.cwd}.\n\n` : ''}Controller read-only request:\n${invocation.prompt}`
        : `/${PLUGIN_NAME}:${requiredSkill} ${invocation.prompt.slice(marker.length + 1)}`,
      timeoutMs: invocation.timeoutMs,
      signal: invocation.signal,
      onStdout: text => sessionObserver.feed(text),
    })
    const parsed = parseClaudeCodeOutput(result.stdout)
    await sessionObserver.finish(parsed.sessionId)
    if (review) {
      return {
        sessionId: parsed.sessionId,
        outcome: 'completed',
        detail: '',
        output: parsed.finalMessage,
      }
    }
    const automationResult = parseAgentAutomationResult(parsed.finalMessage)
    return {
      sessionId: parsed.sessionId,
      outcome: automationResult.outcome,
      detail: automationResult.summary,
      output: parsed.finalMessage,
      automationResult,
    }
  } finally {
    if (review) await rm(review.projectDirectory, { recursive: true, force: true })
    if (pluginDirectory) await rm(pluginDirectory, { recursive: true, force: true })
  }
}
