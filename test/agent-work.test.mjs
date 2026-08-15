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

function agentWork(fields) {
  return `<!-- agent-work:v1 -->\n\`\`\`json\n${JSON.stringify(fields)}\n\`\`\``
}

test('agent-work:v1 parses one ready change declaration', () => {
  const body = [
    '# Implement the integration',
    '',
    '<!-- agent-work:v1 -->',
    '```json',
    '{',
    '  "version": 1,',
    '  "dispatch": "ready",',
    '  "role": "change",',
    '  "kind": "integration",',
    '  "branch": "agent/ci-baseline-integration",',
    '  "dependsOn": [12, 14]',
    '}',
    '```',
  ].join('\n')

  assert.deepEqual(parseAgentWork(body), {
    version: 1,
    dispatch: 'ready',
    role: 'change',
    kind: 'integration',
    branch: 'agent/ci-baseline-integration',
    dependsOn: [12, 14],
  })
})

test('agent-work:v1 rejects ambiguous or unsupported declarations', () => {
  const valid = {
    version: 1,
    dispatch: 'ready',
    role: 'change',
    kind: 'bug-fix',
    dependsOn: [],
  }

  assert.throws(() => parseAgentWork(`${agentWork(valid)}\n${agentWork(valid)}`), /exactly one/)
  assert.throws(() => parseAgentWork(agentWork({ ...valid, command: 'rm -rf .' })), /unknown field command/)
  assert.throws(() => parseAgentWork(agentWork({ ...valid, role: 'review' })), /role/)
  assert.throws(() => parseAgentWork(agentWork({ ...valid, dispatch: 'later' })), /dispatch/)
  assert.throws(() => parseAgentWork(agentWork({ ...valid, kind: 'anything' })), /kind/)
  assert.throws(() => parseAgentWork(agentWork({ ...valid, dependsOn: [2, 2] })), /dependsOn/)
  assert.throws(() => parseAgentWork(agentWork({ ...valid, branch: '../master' })), /branch/)
  assert.throws(() => parseAgentWork('<!-- agent-work:v1 -->\nnot json'), /JSON code block/)
})

test('agent-work:v1 request identity follows canonical work fields, not formatting', () => {
  const fields = {
    version: 1,
    dispatch: 'ready',
    role: 'change',
    kind: 'implementation',
    branch: 'agent/issue-40',
    dependsOn: [3],
  }
  const pretty = agentWork(fields)
  const compact = `<!-- agent-work:v1 -->\n\`\`\`json\n${JSON.stringify(fields)}\n\`\`\``

  assert.equal(agentWorkRequestId(parseAgentWork(pretty)), agentWorkRequestId(parseAgentWork(compact)))
  assert.match(agentWorkRequestId(parseAgentWork(pretty)), /^agent-work-[0-9a-f]{32}$/)
  assert.notEqual(
    agentWorkRequestId(parseAgentWork(pretty)),
    agentWorkRequestId(parseAgentWork(agentWork({ ...fields, dependsOn: [4] }))),
  )
})

test('Agent Issues reevaluates work declarations when trusted Issues change', async () => {
  const workflow = await readFile(new URL('../templates/target/.github/workflows/agent-issues.yml', import.meta.url), 'utf8')
  assert.match(workflow, /types: \[opened, reopened, edited, closed, labeled\]/)
  assert.match(workflow, /contains\(fromJSON\('\["opened","reopened","edited","closed"\]'\), github\.event\.action\)/)
})

test('agent-work:v1 chooses its explicit branch or a deterministic Issue branch', () => {
  const ready = {
    version: 1, dispatch: 'ready', role: 'change', kind: 'implementation', dependsOn: [],
  }
  assert.equal(agentWorkBranch(ready, 40), 'agent/issue-40')
  assert.equal(agentWorkBranch({ ...ready, branch: 'feature/forty' }, 40), 'feature/forty')
  assert.throws(() => agentWorkBranch({ ...ready, dispatch: 'hold' }, 40), /not ready/)
})

test('the Issue worker rejects a stale agent-work dispatch before starting an agent', () => {
  const fields = {
    version: 1, dispatch: 'ready', role: 'change', kind: 'implementation', dependsOn: [],
  }
  const body = agentWork(fields)
  const requestId = agentWorkRequestId(parseAgentWork(body))

  assert.deepEqual(resolveAgentWorkDispatch(body, 40, requestId), {
    work: fields,
    branch: 'agent/issue-40',
  })
  assert.throws(
    () => resolveAgentWorkDispatch(agentWork({ ...fields, kind: 'documentation' }), 40, requestId),
    /changed after dispatch/,
  )
  assert.throws(() => resolveAgentWorkDispatch('The declaration was removed.', 40, requestId), /changed after dispatch/)
})

test('the Issue worker rechecks live dependencies before starting an agent', async () => {
  const work = {
    version: 1, dispatch: 'ready', role: 'change', kind: 'implementation', dependsOn: [12, 14],
  }
  const states = new Map([[12, 'closed'], [14, 'open']])
  assert.deepEqual(await openAgentWorkDependencies(work, async number => ({ number, state: states.get(number) })), [14])
  await assert.rejects(
    openAgentWorkDependencies(work, async number => ({ number, state: 'closed', pull_request: {} })),
    /must reference an Issue/,
  )
})

test('public documentation gives repositories one agent-neutral Issue template', async () => {
  const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8')
  const skill = await readFile(new URL('../dsh-plugin/skills/issue.md', import.meta.url), 'utf8')

  assert.match(readme, /<!-- agent-work:v1 -->/)
  assert.match(readme, /"dispatch": "ready"/)
  assert.match(readme, /`dispatch: "hold"` does not start a Worker/)
  assert.match(readme, /unknown fields fail closed/)
  assert.match(readme, /Issue title, prose, and acceptance criteria remain the human-readable source of work/)
  assert.match(skill, /optional `work` object is the validated `agent-work:v1` routing declaration/)
  assert.match(skill, /The live Issue prose, not the routing object, defines the requested implementation and acceptance criteria/)
})
