import { appendFile } from 'node:fs/promises'
import {
  hostCredentialEnvironment,
  loadConfig,
  requiredEnv,
  run,
} from './common.mjs'
import { dshRpc } from './dsh-web-session.mjs'

const repository = requiredEnv('TARGET_REPOSITORY')
const controllerSha = requiredEnv('CONTROLLER_SHA')
const config = await loadConfig()
if (!config.repositories.includes(repository)) throw new Error(`${repository} is not in the runner allowlist`)
if (!/^[0-9a-f]{40}$/i.test(controllerSha)) throw new Error('CONTROLLER_SHA must be a full commit SHA')

const sessions = await dshRpc(config.dshWebBaseUrl, 'session.list', {})
const codex = await run(config.codexNode, [config.codexScript, '--version'], {
  env: hostCredentialEnvironment({ CODEX_HOME: config.codexHome, NO_COLOR: '1' }),
})
await run(config.ghExecutable, ['repo', 'view', repository, '--json', 'nameWithOwner'], {
  env: hostCredentialEnvironment(),
})

const activeSessions = (sessions.items || []).filter(session => session.running).length
const lines = [
  '# Agent pipeline health',
  '',
  `- Repository: \`${repository}\``,
  `- Controller: \`${controllerSha}\``,
  `- DSH Web Host: reachable at loopback; ${activeSessions} active visible session(s)`,
  `- Codex: \`${codex.stdout.trim()}\``,
  '- GitHub host credential: repository access verified',
  '- Model calls: none',
  '',
]
const report = lines.join('\n')
process.stdout.write(report)
if (process.env.GITHUB_STEP_SUMMARY) {
  await appendFile(process.env.GITHUB_STEP_SUMMARY, report, 'utf8')
}
