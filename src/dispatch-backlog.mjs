import {
  hostCredentialEnvironment,
  loadConfig,
  parseJson,
  requiredEnv,
  run,
} from './common.mjs'
import { selectBacklogWork } from './dispatch-policy.mjs'

const repository = requiredEnv('TARGET_REPOSITORY')
const config = await loadConfig()
if (!config.repositories.includes(repository)) throw new Error(`${repository} is not in the runner allowlist`)

async function ghJson(args, description) {
  const result = await run(config.ghExecutable, args, { env: hostCredentialEnvironment() })
  return parseJson(result.stdout, description)
}

async function ghPages(path, description) {
  const pages = await ghJson(['api', path, '--paginate', '--slurp'], description)
  return pages.flat()
}

const pullRequests = await ghPages(`repos/${repository}/pulls?state=open&per_page=100`, 'open pull requests')
const issues = (await ghPages(`repos/${repository}/issues?state=all&per_page=100`, 'Issues'))
  .filter(issue => !issue.pull_request)
const work = selectBacklogWork({ repository, pullRequests, issues })

if (!work) {
  process.stdout.write('No eligible DSH backlog work is ready.\n')
  process.exit(0)
}

if (work.type === 'repair') {
  await run(config.ghExecutable, [
    'api', '--method', 'POST', `repos/${repository}/dispatches`,
    '-f', 'event_type=dsh-repair',
    '-F', `client_payload[pr_number]=${work.number}`,
    '-f', `client_payload[head_sha]=${work.head}`,
    '-f', 'client_payload[request_id]=backlog',
  ], { env: hostCredentialEnvironment() })
  process.stdout.write(`Dispatched blocked pull request #${work.number} at ${work.head}.\n`)
} else {
  await run(config.ghExecutable, [
    'issue', 'edit', String(work.number), '--repo', repository, '--add-label', 'agent/dsh',
  ], { env: hostCredentialEnvironment() })
  process.stdout.write(`Dispatched Issue #${work.number} with agent/dsh.\n`)
}
