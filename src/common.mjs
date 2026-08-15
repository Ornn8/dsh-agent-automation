import { spawn } from 'node:child_process'
import { readFile, rm } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import { normalizeWorkerConfig } from './agent-worker.mjs'
import { dshModelSelection } from './dsh-web-session.mjs'

/** Run a process without a command shell and return its captured output. */
export function run(command, args, options = {}) {
  const {
    cwd,
    env = process.env,
    input,
    onStdout,
    signal,
    tee = false,
    timeoutMs = 45 * 60 * 1000,
  } = options

  if (signal?.aborted) return Promise.reject(new Error(`${command} was cancelled before start`))
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (callback, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      callback(value)
    }
    const abort = () => {
      child.kill()
      finish(reject, new Error(`${command} was cancelled`))
    }
    const timer = setTimeout(() => {
      child.kill()
      finish(reject, new Error(`${command} timed out after ${timeoutMs} ms`))
    }, timeoutMs)

    child.stdout.on('data', (chunk) => {
      const text = chunk.toString()
      stdout += text
      try {
        onStdout?.(text)
      } catch (error) {
        child.kill()
        finish(reject, error)
      }
      if (tee) process.stdout.write(text)
    })
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString()
      stderr += text
      if (tee) process.stderr.write(text)
    })
    child.once('error', error => finish(reject, error))
    child.once('close', (code, signal) => {
      const result = { code, signal, stdout, stderr }
      if (code !== 0) {
        const detail = stderr.trim() || stdout.trim() || `signal ${signal}`
        finish(reject, new Error(`${command} exited with code ${code}: ${detail}`))
      } else {
        finish(resolvePromise, result)
      }
    })
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()

    child.stdin.end(input)
  })
}

/** Read a required environment variable. */
export function requiredEnv(name) {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`Missing required environment variable ${name}`)
  return value
}

/** Parse a JSON document with a useful error name. */
export function parseJson(text, description) {
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new Error(`${description} is not valid JSON: ${error.message}`, { cause: error })
  }
}

/** Load and validate the machine-local runner configuration. */
export async function loadConfig() {
  const path = resolve(requiredEnv('DSH_AGENT_CONFIG'))
  const config = normalizeWorkerConfig(parseJson(await readFile(path, 'utf8'), 'runner configuration'))
  validateConfigSchemaVersion(config)
  const required = ['repositories', 'ghExecutable', 'gitExecutable']
  for (const name of required) {
    if (name === 'repositories') {
      if (!Array.isArray(config[name]) || config[name].length === 0) {
        throw new Error('runner configuration repositories must be a non-empty array')
      }
    } else if (typeof config[name] !== 'string' || !config[name].trim()) {
      throw new Error(`runner configuration is missing ${name}`)
    }
  }
  if (new Set(config.repositories).size !== config.repositories.length) {
    throw new Error('runner configuration repositories must not contain duplicates')
  }
  for (const repository of config.repositories) {
    resolveRepositoryWorker(config, repository, 'change')
    resolveRepositoryWorker(config, repository, 'review')
  }
  validateDshWorkerConfig(config)
  validateOpenCodeWorkerConfig(config)
  validateClaudeCodeWorkerConfig(config)
  githubLogin(config)
  return config
}

/** Reject configuration formats that predate explicit worker declarations. */
export function validateConfigSchemaVersion(config) {
  if (config?.schemaVersion !== 2 || config?.operations?.schemaVersion !== 2) {
    throw new Error('runner configuration schemaVersion must be 2')
  }
}

/** Validate that every local DSH worker has an explicit complete model selection. */
export function validateDshWorkerConfig(config) {
  for (const [workerId, worker] of Object.entries(config?.workers || {})) {
    if (worker?.adapter !== 'dsh-web') continue
    try {
      dshModelSelection(worker)
    } catch (error) {
      throw new Error(`workers.${workerId} ${error.message}`)
    }
  }
}

/** Resolve a worker from the one local mapping permitted for a repository role. */
export function resolveRepositoryWorker(config, repository, role) {
  if (!['change', 'review'].includes(role)) throw new Error(`Unknown agent role ${role}`)
  const mappings = config?.operations?.repositoryMappings
  if (!Array.isArray(mappings)) throw new Error('runner configuration operations.repositoryMappings must be an array')
  const matches = mappings.filter(mapping => mapping?.repository === repository)
  if (matches.length !== 1) throw new Error(`Repository ${repository} must have exactly one mapping`)
  const workerId = matches[0][role === 'change' ? 'changeWorker' : 'reviewWorker']
  if (typeof workerId !== 'string' || !workerId.trim()) {
    throw new Error(`Repository ${repository} ${role} mapping must name a worker`)
  }
  if (!config?.workers?.[workerId]) throw new Error(`Repository ${repository} ${role} mapping has unknown worker ${workerId}`)
  return workerId
}

/** Return the immutable local GitHub identity that owns controller markers. */
export function githubLogin(config) {
  const login = config?.github?.login
  if (typeof login !== 'string' || !/^[A-Za-z0-9-]{1,39}$/.test(login)) {
    throw new Error('runner configuration github.login must be a GitHub login')
  }
  return login
}

/** Fail closed when the active host credential differs from the configured controller identity. */
export async function verifyGithubIdentity({ config, runCommand = run }) {
  const expectedLogin = githubLogin(config)
  const result = await runCommand(config.ghExecutable, ['api', 'user'], { env: hostCredentialEnvironment() })
  const actualLogin = parseJson(result.stdout, 'GitHub authenticated user').login
  if (actualLogin !== expectedLogin) {
    throw new Error(`GitHub host credential is ${actualLogin || '<missing>'}, expected ${expectedLogin}`)
  }
  return expectedLogin
}

/** Return an environment that cannot make GitHub CLI use an Actions token. */
export function hostCredentialEnvironment(overrides = {}, source = process.env) {
  const environment = { ...source }
  delete environment.GH_TOKEN
  delete environment.GITHUB_TOKEN
  return Object.assign(environment, overrides)
}

const REVIEWER_ENVIRONMENT_KEYS = new Set([
  'APPDATA', 'COMSPEC', 'LOCALAPPDATA', 'NUMBER_OF_PROCESSORS', 'OS', 'PATH',
  'PATHEXT', 'PROCESSOR_ARCHITECTURE', 'PROGRAMDATA', 'PROGRAMFILES',
  'PROGRAMFILES(X86)', 'PROGRAMW6432', 'SYSTEMROOT', 'TEMP', 'TMP',
  'USERPROFILE', 'WINDIR',
])

/** Return a minimal process environment for an untrusted, read-only reviewer. */
export function reviewerCredentialEnvironment(overrides = {}, source = process.env) {
  const environment = {}
  for (const [name, value] of Object.entries(source)) {
    if (REVIEWER_ENVIRONMENT_KEYS.has(name.toUpperCase())) environment[name] = value
  }
  return Object.assign(environment, {
    GCM_INTERACTIVE: 'Never',
    GH_PROMPT_DISABLED: '1',
    GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
  }, overrides)
}

/** Return an environment that forces GitHub CLI to use the current Actions token. */
export function actionsCredentialEnvironment(overrides = {}, source = process.env) {
  const environment = { ...source, ...overrides }
  const token = environment.GITHUB_TOKEN?.trim()
  if (!token) throw new Error('Missing required environment variable GITHUB_TOKEN')
  environment.GH_TOKEN = token
  return environment
}

/** Return the backtick-delimited branch explicitly declared by an Issue. */
export function declaredIssueBranch(body) {
  return String(body || '').match(/\b(?:branch|branch name)\s*:?\s*`([^`\r\n]+)`/i)?.[1]?.trim() || ''
}

/** Validate every OpenCode CLI worker before any task can reach the executable. */
export function validateOpenCodeWorkerConfig(config) {
  for (const [workerId, worker] of Object.entries(config?.workers || {})) {
    if (worker?.adapter !== 'opencode-cli') continue
    for (const field of ['executable', 'model', 'variant']) {
      if (typeof worker[field] !== 'string' || !worker[field].trim()) {
        throw new Error(`workers.${workerId} ${field} must be a non-empty string`)
      }
    }
    if (!/^[^/\s]+\/[^/\s]+$/.test(worker.model)) {
      throw new Error(`workers.${workerId} model must be provider/model`)
    }
    if (!['change', 'review'].includes(worker.mode)) {
      throw new Error(`workers.${workerId} mode must be change or review`)
    }
    if (worker.agent !== undefined && (typeof worker.agent !== 'string' || !worker.agent.trim())) {
      throw new Error(`workers.${workerId} agent must be a non-empty string`)
    }
    if (worker.mode === 'review'
      && (typeof worker.gitExecutable !== 'string' || !worker.gitExecutable.trim())) {
      throw new Error(`workers.${workerId} gitExecutable must be a non-empty string for review`)
    }
  }
}

const CLAUDE_CODE_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max', 'ultracode'])

/** Validate every Claude Code CLI worker before any task can reach the executable. */
export function validateClaudeCodeWorkerConfig(config) {
  for (const [workerId, worker] of Object.entries(config?.workers || {})) {
    if (worker?.adapter !== 'claude-code-cli') continue
    for (const field of ['executable', 'model', 'effort']) {
      if (typeof worker[field] !== 'string' || !worker[field].trim()) {
        throw new Error(`workers.${workerId} ${field} must be a non-empty string`)
      }
    }
    if (!CLAUDE_CODE_EFFORTS.has(worker.effort)) {
      throw new Error(`workers.${workerId} effort must be a supported Claude Code effort`)
    }
    if (!['change', 'review'].includes(worker.mode)) {
      throw new Error(`workers.${workerId} mode must be change or review`)
    }
    if (worker.mode === 'review'
      && (typeof worker.gitExecutable !== 'string' || !worker.gitExecutable.trim())) {
      throw new Error(`workers.${workerId} gitExecutable must be a non-empty string for review`)
    }
  }
}

/** Validate one repository branch declared by an automation Issue. */
export function validateIssueBranch(branch) {
  if (typeof branch !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(branch)
    || branch.includes('..')
    || branch.includes('@{')
    || branch.endsWith('.')
    || branch.endsWith('/')) {
    throw new Error(`The Issue declares an unsafe branch name: ${String(branch)}`)
  }
  return branch
}

/** Parse and validate the branch declared by an automation Issue. */
export function issueBranch(body, fallback) {
  const branch = declaredIssueBranch(body)
  if (!branch && Number.isSafeInteger(fallback?.number) && fallback.number > 0) {
    return `agent/issue-${fallback.number}`
  }
  if (!branch) throw new Error('The Issue must declare a backtick-delimited branch name')
  return validateIssueBranch(branch)
}

/** Return whether an Issue author may dispatch the privileged local agent. */
export function trustedAssociation(association) {
  return ['OWNER', 'MEMBER', 'COLLABORATOR'].includes(association)
}

/** Return whether a marker was authored by the configured controller identity. */
export function authenticatedMarker(comment, marker, login) {
  return typeof login === 'string' && login.length > 0
    && comment?.user?.login === login
    && comment.body?.includes(marker)
}

/** Reject an Issue branch that would write the repository's protected default branch. */
export function authorizedIssueBranch(issueNumber, branch, defaultBranch) {
  if (!Number.isSafeInteger(issueNumber) || issueNumber < 1) throw new Error('Issue number must be positive')
  if (typeof branch !== 'string' || !branch) throw new Error(`Issue #${issueNumber} has no work branch`)
  if (branch === defaultBranch) throw new Error(`Issue #${issueNumber} cannot use the protected default branch ${defaultBranch}`)
  return branch
}

/** Bind normal process cancellation signals to one controller-owned operation. */
export function processCancellationSignal(processImpl = process) {
  const controller = new AbortController()
  const listeners = new Map()
  for (const signal of ['SIGINT', 'SIGTERM']) {
    const listener = () => controller.abort(new Error(`Received ${signal}`))
    listeners.set(signal, listener)
    processImpl.once(signal, listener)
  }
  return {
    signal: controller.signal,
    dispose() {
      for (const [signal, listener] of listeners) processImpl.removeListener(signal, listener)
    },
  }
}

/** Remove a job directory only when it is a strict descendant of its declared root. */
export async function removeJobDirectory(root, target) {
  const rootPath = resolve(root)
  const targetPath = resolve(target)
  const child = relative(rootPath, targetPath)
  if (!child || child.startsWith('..') || isAbsolute(child)) {
    throw new Error(`Refusing to remove job directory outside ${rootPath}: ${targetPath}`)
  }
  await rm(targetPath, { recursive: true, force: true })
}
