import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { loadWorkflowProfile } from '../src/workflow-profile.mjs'
import { subjectStateVersion } from '../src/governor-policy.mjs'
import {
  capacityResumeRequestId,
  capacityWaitStatusLine,
  createCapacityWaitProjection,
} from '../src/capacity-wait-projection.mjs'
import { classifyAndCreateWorkerRouteDecision } from '../src/worker-routing.mjs'

const repository = 'owner/repository'
const controllerRepository = 'owner/controller'
const controllerSha = 'c'.repeat(40)
const base = 'b'.repeat(40)
const head = 'a'.repeat(40)
const profileId = 'github-pr-cycle'

function runNode(script, args, options) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], options)
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }))
  })
}

test('dsh-repair capacity-resume entry parses its trusted repair status before governor admission', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-repair-capacity-entry-'))
  const apiPath = join(process.cwd(), 'api')
  try {
    const profile = await loadWorkflowProfile(profileId)
    const workRequest = {
      version: 2,
      requestId: 'repair-request-1',
      profileId,
      workflowId: 'repair',
      stageId: 'change',
      definitionHash: profile.definitionHash,
      role: 'change',
      repository,
      subject: { type: 'pull-request', number: 12 },
      revision: { base, head },
      coordinationKey: `${repository}:${profileId}:repair`,
    }
    const stateVersion = subjectStateVersion({
      type: 'pull-request', number: 12, state: 'open', draft: false, base, head,
      labels: [{ name: 'automation/review-blocked' }],
    })
    const routeDecision = classifyAndCreateWorkerRouteDecision({
      workRequest, subjectStateVersion: stateVersion,
      routingPolicy: { version: 1, default: 'default', routes: { default: {} } },
    })
    const projection = createCapacityWaitProjection({
      workRequestId: workRequest.requestId,
      role: workRequest.role,
      profileId,
      workflowId: workRequest.workflowId,
      stageId: workRequest.stageId,
      definitionHash: profile.definitionHash,
      revision: { base, head },
      subject: { type: 'pull-request', number: 12, stateVersion, base, head },
      routeDecision,
      capacityGenerationHash: 'd'.repeat(64),
      observationId: '101:1',
    })
    const capacityResumeId = capacityResumeRequestId(projection)
    const runUrl = `https://github.com/${repository}/actions/runs/101`
    const statusBody = [
      `<!-- dsh-review-repair:${controllerSha}:${head}:${workRequest.requestId} -->`,
      '### DSH review repair',
      '',
      '- Status: **capacity-waiting**',
      `- Profile: \`${profileId}\``,
      '- Workflow: `repair`',
      `- Definition hash: \`${profile.definitionHash}\``,
      `- Controller SHA: \`${controllerSha}\``,
      '- Repair class: `automatic-review`',
      '- Stage: `change`',
      `- Reviewed head: \`${head}\``,
      '- Branch: `feature/capacity`',
      `- Run: ${runUrl}`,
      capacityWaitStatusLine(projection),
      '- Detail: waiting',
    ].join('\n')
    const pullRequest = {
      number: 12,
      state: 'open',
      draft: false,
      body: 'repair',
      head: { sha: head, ref: 'feature/capacity', repo: { full_name: repository } },
      base: { sha: base, ref: 'main' },
      labels: [{ name: 'automation/review-blocked' }],
    }
    const comments = [{ id: 1, user: { login: 'controller' }, body: statusBody }]
    const profileContent = Buffer.from(JSON.stringify(profile.definition)).toString('base64')
    const mockGhSource = `
const args = ['api', ...process.argv.slice(2)]
const text = args.join(' ')
const pullRequest = ${JSON.stringify(pullRequest)}
const comments = ${JSON.stringify(comments)}
if (args[0] === 'api' && args[1] === 'user') process.stdout.write(JSON.stringify({ login: 'controller' }))
else if (text.includes('/pulls/12/files?')) process.stdout.write(JSON.stringify([{ filename: 'src/example.mjs' }]))
else if (text.includes('/contents/.github/agent-automation/profiles/${profileId}.json')) process.stdout.write(JSON.stringify({ encoding: 'base64', content: '${profileContent}' }))
else if (text.includes('/issues/12/comments')) process.stdout.write(JSON.stringify([comments]))
else if (text.includes('/pulls/12')) process.stdout.write(JSON.stringify(pullRequest))
else process.stdout.write(JSON.stringify({}))
`
    await writeFile(apiPath, mockGhSource)
    const config = {
      credentialGeneration: 'test',
      github: { login: 'controller' },
      ghExecutable: process.execPath,
      gitExecutable: process.execPath,
      workers: {
        change: { adapter: 'opencode-cli', executable: process.execPath, model: 'test/model', variant: 'max' },
        review: { adapter: 'opencode-cli', executable: process.execPath, model: 'test/model', variant: 'max' },
        maintenance: { adapter: 'opencode-cli', executable: process.execPath, model: 'test/model', variant: 'max' },
      },
      operations: {
        controller: { repository: controllerRepository },
        repositoryMappings: [{ repository, ciWorkflows: ['CI'], requiredChecks: ['all checks passed'] }],
        roles: {
          change: { workers: ['change'] },
          review: { workers: ['review'] },
          maintenance: { workers: ['maintenance'] },
        },
      },
    }
    const configPath = join(directory, 'config.json')
    await writeFile(configPath, JSON.stringify(config))
    const result = await runNode('src/dsh-repair.mjs', [], {
      cwd: new URL('..', import.meta.url),
      env: {
        ...process.env,
        DSH_AGENT_CONFIG: configPath,
        TARGET_REPOSITORY: repository,
        PR_NUMBER: '12',
        HEAD_SHA: head,
        REPAIR_REQUEST_ID: capacityResumeId,
        CAPACITY_RESUME_ID: capacityResumeId,
        WORK_REQUEST_JSON: JSON.stringify(workRequest),
        DEFAULT_BRANCH: 'main',
        RUN_URL: runUrl,
        CONTROLLER_REPOSITORY: controllerRepository,
        CONTROLLER_SHA: controllerSha,
        GITHUB_RUN_ID: '900',
        GITHUB_RUN_ATTEMPT: '1',
        GITHUB_TOKEN: 'test-token',
        AGENT_ROLE: 'change',
        RUNNER_TEMP: directory,
      },
    })
    assert.notEqual(result.code, 0)
    assert.doesNotMatch(result.stderr, /recordedRepairStatus is not defined/)
    assert.match(`${result.stdout}\n${result.stderr}`, /no current controller-attested repair admission/)
  } finally {
    await rm(apiPath, { force: true })
    await rm(directory, { recursive: true, force: true })
  }
})
