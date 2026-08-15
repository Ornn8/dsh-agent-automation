import path from 'node:path'
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { reviewerCredentialEnvironment, run } from '../src/common.mjs'
import { runOpenCodeCli } from '../src/opencode-cli.mjs'

function setting(name, fallback) {
  const value = process.env[name]?.trim() || fallback
  if (!value) throw new Error(`${name} must be a non-empty string`)
  return value
}

async function git(checkout, args) {
  return run(setting('OPENCODE_SMOKE_GIT', 'git'), ['-C', checkout, ...args], { timeoutMs: 30_000 })
}

async function executable() {
  if (process.env.OPENCODE_SMOKE_EXECUTABLE?.trim()) return process.env.OPENCODE_SMOKE_EXECUTABLE.trim()
  if (process.platform !== 'win32') return 'opencode'
  for (const directory of (process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
    const installed = path.join(directory, 'opencode.exe')
    try {
      await access(installed)
      return installed
    } catch {
      // Continue to the npm package layout.
    }
    const npxPackage = path.resolve(directory, '..', 'opencode-ai', 'bin', 'opencode.exe')
    try {
      await access(path.join(directory, 'opencode.cmd'))
      await access(npxPackage)
      return npxPackage
    } catch {
      // Continue to the next PATH entry.
    }
  }
  throw new Error('OpenCode executable was not found; set OPENCODE_SMOKE_EXECUTABLE')
}

const root = await mkdtemp(path.join(tmpdir(), 'agent-opencode-smoke-'))
try {
  await git(root, ['init', '--quiet'])
  await git(root, ['config', 'user.name', 'Agent adapter smoke'])
  await git(root, ['config', 'user.email', 'adapter-smoke@example.invalid'])
  await writeFile(path.join(root, 'value.js'), 'export const value = 1\n', 'utf8')
  await git(root, ['add', 'value.js'])
  await git(root, ['commit', '--quiet', '-m', 'Add smoke fixture'])
  const base = (await git(root, ['rev-parse', 'HEAD'])).stdout.trim()
  await writeFile(path.join(root, 'value.js'), 'export const value = 2\n', 'utf8')
  await git(root, ['add', 'value.js'])
  await git(root, ['commit', '--quiet', '-m', 'Update smoke fixture'])
  const head = (await git(root, ['rev-parse', 'HEAD'])).stdout.trim()

  const credentialName = setting('OPENCODE_SMOKE_CREDENTIAL_ENV', 'DEEPSEEK_API_KEY')
  if (!/^[A-Z][A-Z0-9_]*$/.test(credentialName)) {
    throw new Error('OPENCODE_SMOKE_CREDENTIAL_ENV must name one uppercase environment variable')
  }
  const credential = setting(credentialName)
  const model = setting('OPENCODE_SMOKE_MODEL', 'deepseek/deepseek-v4-flash')
  const variant = setting('OPENCODE_SMOKE_VARIANT', 'max')
  const receipt = await runOpenCodeCli({
    worker: {
      executable: await executable(),
      gitExecutable: setting('OPENCODE_SMOKE_GIT', 'git'),
      mode: 'review',
      model,
      variant,
    },
    invocation: {
      taskId: `review-${base}-${head}`,
      cwd: root,
      title: 'OpenCode adapter provider smoke',
      prompt: 'Review the exact synthetic pair. Return `VERDICT: PASS` when it has no P0/P1 defect; otherwise return `VERDICT: BLOCK` and the finding.',
      requiredSkill: 'github-pr-review',
      timeoutMs: 180_000,
      onStarted: async () => undefined,
    },
    runCommand: run,
    environment: reviewerCredentialEnvironment({ [credentialName]: credential, NO_COLOR: '1' }),
  })
  if (!/^VERDICT: (?:PASS|BLOCK)\b/m.test(receipt.output)) {
    throw new Error('OpenCode adapter smoke did not return a review verdict')
  }
  process.stdout.write(`OpenCode adapter smoke passed: model=${model}, variant=${variant}, session=${receipt.sessionId}\n`)
} finally {
  await rm(root, { recursive: true, force: true })
}
