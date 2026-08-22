import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import {
  agentWorkBranch,
  agentWorkRequestId,
  openAgentWorkDependencies,
  parseAgentWork,
  resolveAgentWorkDispatch,
} from '../src/agent-work.mjs'
import { loadWorkflowProfile } from '../src/workflow-profile.mjs'

const profile = await loadWorkflowProfile()

function agentWork(fields) {
  return `<!-- agent-work:v2 -->\n\`\`\`json\n${JSON.stringify(fields)}\n\`\`\``
}

test('agent-work:v2 selects orchestration without naming an Agent or procedure', () => {
  const body = [
    '# Implement the integration',
    '',
    '<!-- agent-work:v2 -->',
    '```json',
    '{',
    '  "version": 2,',
    '  "dispatch": "ready",',
    '  "profile": "github-pr-cycle",',
    '  "workflow": "default",',
    '  "branch": "agent/ci-baseline-integration",',
    '  "dependsOn": [12, 14]',
    '}',
    '```',
  ].join('\n')

  assert.deepEqual(parseAgentWork(body), {
    version: 2,
    dispatch: 'ready',
    profile: 'github-pr-cycle',
    workflow: 'default',
    branch: 'agent/ci-baseline-integration',
    dependsOn: [12, 14],
  })
})

test('agent-work:v2 supplies the bundled Profile default but keeps workflow explicit', () => {
  assert.deepEqual(parseAgentWork(agentWork({
    version: 2, dispatch: 'hold', workflow: 'default', dependsOn: [],
  })), {
    version: 2,
    dispatch: 'hold',
    profile: 'github-pr-cycle',
    workflow: 'default',
    dependsOn: [],
  })
})

test('agent-work:v2 rejects commands, Agent choices, and ambiguous declarations', () => {
  const valid = { version: 2, dispatch: 'ready', workflow: 'default', dependsOn: [] }
  assert.throws(() => parseAgentWork(`${agentWork(valid)}\n${agentWork(valid)}`), /exactly one/)
  assert.throws(() => parseAgentWork(agentWork({ ...valid, command: 'rm -rf .' })), /unknown field command/)
  assert.throws(() => parseAgentWork(agentWork({ ...valid, role: 'review' })), /unknown field role/)
  assert.throws(() => parseAgentWork(agentWork({ ...valid, dispatch: 'later' })), /dispatch/)
  assert.throws(() => parseAgentWork(agentWork({ ...valid, workflow: '../other' })), /workflow/)
  assert.throws(() => parseAgentWork(agentWork({ ...valid, dependsOn: [2, 2] })), /dependsOn/)
  assert.throws(() => parseAgentWork(agentWork({ ...valid, branch: '../master' })), /branch/)
  assert.throws(() => parseAgentWork('<!-- agent-work:v2 -->\nnot json'), /JSON code block/)
  assert.equal(parseAgentWork('<!-- agent-work:v1 -->\n```json\n{}\n```'), null)
})

test('request identity binds normalized work and exact Profile hash', () => {
  const fields = {
    version: 2, dispatch: 'ready', workflow: 'default', branch: 'agent/issue-40', dependsOn: [3],
  }
  const work = parseAgentWork(agentWork(fields))
  assert.equal(agentWorkRequestId(work, profile.definitionHash), agentWorkRequestId({ ...work }, profile.definitionHash))
  assert.match(agentWorkRequestId(work, profile.definitionHash), /^agent-work-[0-9a-f]{32}$/)
  assert.notEqual(agentWorkRequestId(work, profile.definitionHash), agentWorkRequestId(work, '0'.repeat(64)))
  assert.notEqual(
    agentWorkRequestId(work, profile.definitionHash),
    agentWorkRequestId(work, profile.definitionHash, 'f'.repeat(64)),
  )
  assert.throws(() => agentWorkRequestId(work, profile.definitionHash, 'bad'), /Contract hash/)
})

test('Agent Issues reevaluates work declarations when trusted Issues change', async () => {
  const workflow = await readFile(new URL('../templates/target/.github/workflows/agent-issues.yml', import.meta.url), 'utf8')
  assert.match(workflow, /types: \[opened, reopened, edited, closed, labeled\]/)
})

test('agent-work:v2 chooses its explicit branch or deterministic Issue branch', () => {
  const ready = {
    version: 2, dispatch: 'ready', profile: 'github-pr-cycle', workflow: 'default', dependsOn: [],
  }
  assert.equal(agentWorkBranch(ready, 40), 'agent/issue-40')
  assert.equal(agentWorkBranch({ ...ready, branch: 'feature/forty' }, 40), 'feature/forty')
  assert.throws(() => agentWorkBranch({ ...ready, dispatch: 'hold' }, 40), /not ready/)
})

test('the Issue worker rejects stale declarations and Profile revisions before starting an Agent', () => {
  const fields = { version: 2, dispatch: 'ready', workflow: 'default', dependsOn: [] }
  const body = agentWork(fields)
  const parsed = parseAgentWork(body)
  const contractHash = 'f'.repeat(64)
  const requestId = agentWorkRequestId(parsed, profile.definitionHash, contractHash)
  assert.deepEqual(resolveAgentWorkDispatch(body, 40, requestId, profile.definitionHash, contractHash), {
    work: parsed,
    branch: 'agent/issue-40',
  })
  assert.throws(
    () => resolveAgentWorkDispatch(agentWork({ ...fields, workflow: 'repair' }), 40, requestId, profile.definitionHash, contractHash),
    /changed after dispatch/,
  )
  assert.throws(() => resolveAgentWorkDispatch(body, 40, requestId, '0'.repeat(64), contractHash), /changed after dispatch/)
  assert.throws(() => resolveAgentWorkDispatch(body, 40, requestId, profile.definitionHash), /changed after dispatch/)
})

test('the Issue worker rechecks live dependencies before starting an Agent', async () => {
  const work = {
    version: 2, dispatch: 'ready', profile: 'github-pr-cycle', workflow: 'default', dependsOn: [12, 14],
  }
  const states = new Map([[12, 'closed'], [14, 'open']])
  assert.deepEqual(await openAgentWorkDependencies(work, async number => ({ number, state: states.get(number) })), [14])
  await assert.rejects(
    openAgentWorkDependencies(work, async number => ({ number, state: 'closed', pull_request: {} })),
    /must reference an Issue/,
  )
})
