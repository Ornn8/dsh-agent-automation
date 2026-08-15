import path from 'node:path'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import {
  AGENT_REVIEW_SKILL,
  agentSkillDefinition,
  parseAgentAutomationResult,
} from './agent-work-result.mjs'
import { prepareAgentReviewInput } from './agent-review-input.mjs'

function requiredText(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} must be a non-empty string`)
  return value.trim()
}

/** Parse one completed OpenCode NDJSON stream into its terminal assistant message. */
export function parseOpenCodeRunOutput(stdout) {
  const events = String(stdout || '').split(/\r?\n/).filter(line => line.trim()).map((line, index) => {
    try {
      return JSON.parse(line)
    } catch (error) {
      throw new Error(`OpenCode output line ${index + 1} is not valid JSON: ${error.message}`, { cause: error })
    }
  })
  if (events.length === 0) throw new Error('OpenCode produced no JSON events')
  const sessionIds = new Set(events.map(event => event?.sessionID).filter(Boolean))
  if (sessionIds.size !== 1) throw new Error('OpenCode output must contain exactly one sessionID')
  const failure = events.find(event => event?.type === 'error')
  if (failure) throw new Error(`OpenCode session failed: ${JSON.stringify(failure.error || failure)}`)
  const textEvents = events.filter(event => event?.type === 'text'
    && typeof event.part?.messageID === 'string'
    && typeof event.part?.text === 'string'
    && event.part.text.trim())
  if (textEvents.length === 0) throw new Error('OpenCode completed without a terminal assistant message')
  const finalMessageId = textEvents.at(-1).part.messageID
  const finalMessage = textEvents
    .filter(event => event.part.messageID === finalMessageId)
    .map(event => event.part.text)
    .join('')
  return { sessionId: [...sessionIds][0], finalMessage }
}

async function prepareReview({ worker, invocation, runCommand, environment }) {
  const gitExecutable = requiredText(worker.gitExecutable, 'OpenCode review git executable')
  return prepareAgentReviewInput({
    checkout: invocation.cwd,
    taskId: invocation.taskId,
    gitExecutable,
    runCommand,
    environment,
    timeoutMs: invocation.timeoutMs,
    signal: invocation.signal,
    directoryPrefix: 'dsh-opencode-review-',
  })
}

function reviewConfiguration(checkout) {
  return JSON.stringify({
    agent: {
      'controller-review': {
        description: 'Read-only review of one controller-verified pull request pair.',
        mode: 'primary',
        permission: {
          edit: 'deny',
          bash: 'deny',
          task: 'deny',
          webfetch: 'deny',
          websearch: 'deny',
          lsp: 'deny',
          question: 'deny',
          skill: { '*': 'deny', [AGENT_REVIEW_SKILL]: 'allow' },
          external_directory: { '*': 'deny', [path.join(checkout, '**')]: 'allow' },
        },
      },
    },
  })
}

function observeOpenCodeSession(onStarted) {
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
          const sessionId = JSON.parse(line)?.sessionID
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

async function materializeSkill(skillName) {
  const skill = agentSkillDefinition(skillName)
  const configDirectory = await mkdtemp(path.join(tmpdir(), 'dsh-opencode-config-'))
  try {
    const skillDirectory = path.join(configDirectory, 'skills', skillName)
    await mkdir(skillDirectory, { recursive: true })
    const source = await readFile(skill.source, 'utf8')
    const frontmatter = `---\nname: ${skillName}\ndescription: ${skill.description}\ncompatibility: opencode\n---\n\n`
    await writeFile(path.join(skillDirectory, 'SKILL.md'), `${frontmatter}${source}`, 'utf8')
    return configDirectory
  } catch (error) {
    await rm(configDirectory, { recursive: true, force: true })
    throw error
  }
}

/** Run one controller invocation through the official non-interactive OpenCode CLI. */
export async function runOpenCodeCli({ worker, invocation, runCommand, environment }) {
  if (!['change', 'review'].includes(worker.mode)) {
    throw new Error('OpenCode CLI worker mode must be change or review')
  }
  const executable = requiredText(worker.executable, 'OpenCode executable')
  const model = requiredText(worker.model, 'OpenCode model')
  const variant = requiredText(worker.variant, 'OpenCode variant')
  const requiredSkill = requiredText(invocation.requiredSkill, 'OpenCode change skill')
  const marker = `/${requiredSkill}`
  if (worker.mode === 'change' && !invocation.prompt.startsWith(`${marker} `)) {
    throw new Error(`OpenCode change prompt must invoke ${marker}`)
  }
  if (worker.mode === 'review' && requiredSkill !== AGENT_REVIEW_SKILL) {
    throw new Error(`OpenCode review must use ${AGENT_REVIEW_SKILL}`)
  }
  const args = [
    ...(worker.mode === 'review' ? ['--pure'] : []),
    'run', '--format', 'json', '--auto', '--model', model, '--variant', variant,
    '--title', invocation.title,
  ]
  const agent = worker.mode === 'review' ? 'controller-review' : worker.agent?.trim()
  if (agent) args.push('--agent', agent)
  const configDirectory = await materializeSkill(requiredSkill)
  let review
  try {
    if (worker.mode === 'review') {
      review = await prepareReview({ worker, invocation, runCommand, environment })
    }
    const sessionObserver = observeOpenCodeSession(invocation.onStarted)
    const result = await runCommand(executable, args, {
      cwd: review?.projectDirectory || invocation.cwd,
      env: {
        ...environment,
        OPENCODE_CONFIG_DIR: configDirectory,
        ...(review ? {
          OPENCODE_CONFIG_CONTENT: reviewConfiguration(invocation.cwd),
          OPENCODE_AUTO_SHARE: 'false',
          OPENCODE_DISABLE_CLAUDE_CODE: 'true',
          OPENCODE_DISABLE_DEFAULT_PLUGINS: 'true',
          OPENCODE_DISABLE_LSP_DOWNLOAD: 'true',
        } : {}),
      },
      input: worker.mode === 'review'
        ? `Use the ${requiredSkill} skill. The trusted review input is review-input.json. The exact head checkout is ${invocation.cwd}.\n\nController review request:\n${invocation.prompt}`
        : `Use the ${requiredSkill} skill for this controller request.\n\nController request:\n${invocation.prompt.slice(marker.length + 1)}`,
      timeoutMs: invocation.timeoutMs,
      signal: invocation.signal,
      onStdout: text => sessionObserver.feed(text),
    })
    const parsed = parseOpenCodeRunOutput(result.stdout)
    await sessionObserver.finish(parsed.sessionId)
    if (worker.mode === 'review') {
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
    await rm(configDirectory, { recursive: true, force: true })
  }
}
