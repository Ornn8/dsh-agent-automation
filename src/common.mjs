import { spawn } from 'node:child_process'
import { readFile, rm } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import { normalizeWorkerConfig } from './agent-worker.mjs'

/** Run a process without a command shell and return its captured output. */
export function run(command, args, options = {}) {
  const {
    cwd,
    env = process.env,
    input,
    tee = false,
    timeoutMs = 45 * 60 * 1000,
  } = options

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
      callback(value)
    }
    const timer = setTimeout(() => {
      child.kill()
      finish(reject, new Error(`${command} timed out after ${timeoutMs} ms`))
    }, timeoutMs)

    child.stdout.on('data', (chunk) => {
      const text = chunk.toString()
      stdout += text
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
  return config
}

/** Return an environment that cannot make GitHub CLI use an Actions token. */
export function hostCredentialEnvironment(overrides = {}, source = process.env) {
  const environment = { ...source }
  delete environment.GH_TOKEN
  delete environment.GITHUB_TOKEN
  return Object.assign(environment, overrides)
}

/** Return an environment that forces GitHub CLI to use the current Actions token. */
export function actionsCredentialEnvironment(overrides = {}, source = process.env) {
  const environment = { ...source, ...overrides }
  const token = environment.GITHUB_TOKEN?.trim()
  if (!token) throw new Error('Missing required environment variable GITHUB_TOKEN')
  environment.GH_TOKEN = token
  return environment
}

/** Parse and validate the branch declared by an automation Issue. */
export function issueBranch(body, fallback) {
  const branch = body.match(/^\s*(?:[-*]\s*)?(?:branch|branch name)\s*:\s*`([^`]+)`\s*$/im)?.[1]?.trim()
  if (!branch && Number.isSafeInteger(fallback?.number) && fallback.number > 0) {
    return `agent/issue-${fallback.number}`
  }
  if (!branch) throw new Error('The Issue must declare `Branch: `name`` on its own line')
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(branch)
    || branch.includes('..')
    || branch.includes('@{')
    || branch.endsWith('.')
    || branch.endsWith('/')) {
    throw new Error(`The Issue declares an unsafe branch name: ${branch}`)
  }
  return branch
}

/** Return whether an Issue author may dispatch the privileged local agent. */
export function trustedAssociation(association) {
  return ['OWNER', 'MEMBER', 'COLLABORATOR'].includes(association)
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
