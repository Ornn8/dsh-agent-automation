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

function agentWorkV3(fields, prose = true) {
  const sections = prose ? [
    '## Objective', '', 'Implement one bounded task.', '',
    '## Scope', '', '- Keep the change independently reviewable.', '',
    '## Acceptance criteria', '', '- The focused contract tests pass.', '',
  ].join('\n') : ''
  return `${sections}\n\n<!-- agent-work:v3 -->\n\`\`\`json\n${JSON.stringify(fields)}\n\`\`\``
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
    taskClass: 'default',
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
    taskClass: 'default',
    dependsOn: [],
  })
})

test('agent-work:v3 parses one executable child with its abstract route class', () => {
  assert.deepEqual(parseAgentWork(agentWorkV3({
    version: 3,
    dispatch: 'ready',
    profile: 'github-pr-cycle',
    workflow: 'default',
    parent: 100,
    taskClass: 'frontend',
    dependsOn: [101],
  }), { issueNumber: 102 }), {
    version: 3,
    dispatch: 'ready',
    profile: 'github-pr-cycle',
    workflow: 'default',
    parent: 100,
    taskClass: 'frontend',
    dependsOn: [101],
  })
})

test('agent-work:v3 requires executable prose and rejects mixed or unknown declarations', () => {
  const valid = {
    version: 3, dispatch: 'ready', workflow: 'default', parent: 100, taskClass: 'frontend', dependsOn: [],
  }
  assert.throws(() => parseAgentWork(agentWorkV3(valid, false)), /Objective/)
  assert.throws(() => parseAgentWork(agentWorkV3({ ...valid, extra: 'nope' })), /unknown field extra/)
  assert.throws(
    () => parseAgentWork(`${agentWorkV3(valid)}\n${agentWork(valid)}`),
    /exactly one recognized/,
  )
  assert.throws(() => parseAgentWork(agentWorkV3({ ...valid, taskClass: 'worker/id' })), /taskClass/)
  assert.throws(() => parseAgentWork(agentWorkV3({ ...valid, taskClass: 'model command' })), /taskClass/)
  assert.throws(() => parseAgentWork(agentWorkV3({ ...valid, parent: 0 })), /parent/)
})

test('agent-work:v3 rejects self references when the executable Issue number is supplied', () => {
  const valid = {
    version: 3, dispatch: 'ready', workflow: 'default', parent: 100, taskClass: 'frontend', dependsOn: [],
  }
  assert.throws(
    () => parseAgentWork(agentWorkV3({ ...valid, parent: 102 }), { issueNumber: 102 }),
    /parent must not reference/,
  )
  assert.throws(
    () => parseAgentWork(agentWorkV3({ ...valid, dependsOn: [102] }), { issueNumber: 102 }),
    /dependsOn must not reference/,
  )
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

test('request identity binds normalized work, exact Profile, and Issue subject', () => {
  const fields = {
    version: 2, dispatch: 'ready', workflow: 'default', branch: 'agent/issue-40', dependsOn: [3],
  }
  const work = parseAgentWork(agentWork(fields))
  const id = (value, repository = 'Ornn8/example', issueNumber = 40) =>
    agentWorkRequestId(value, profile.definitionHash, undefined, repository, issueNumber)
  assert.equal(id(work), id({ ...work }))
  assert.match(id(work), /^agent-work-[0-9a-f]{32}$/)
  assert.notEqual(id(work), agentWorkRequestId(work, '0'.repeat(64), undefined, 'Ornn8/example', 40))
  assert.notEqual(
    id(work),
    agentWorkRequestId(work, profile.definitionHash, 'f'.repeat(64), 'Ornn8/example', 40),
  )
  assert.notEqual(id(work), id(work, 'Ornn8/example', 41))
  assert.notEqual(id(work), id(work, 'Ornn8/other'))
  assert.throws(() => agentWorkRequestId(work, profile.definitionHash, 'bad', 'Ornn8/example', 40), /Contract hash/)
  assert.throws(() => agentWorkRequestId(work, profile.definitionHash, undefined, 'not-a-repository', 40), /repository/)
  assert.throws(() => agentWorkRequestId(work, profile.definitionHash, undefined, 'Ornn8/example', 0), /Issue number/)
})

test('v3 identity changes when normalized planning fields change', () => {
  const fields = {
    version: 3, dispatch: 'ready', workflow: 'default', parent: 100, taskClass: 'frontend', dependsOn: [101],
  }
  const work = parseAgentWork(agentWorkV3(fields), { issueNumber: 102 })
  const id = value => agentWorkRequestId(value, profile.definitionHash, undefined, 'Ornn8/example', 102)
  assert.notEqual(id(work), id({ ...work, parent: 103 }))
  assert.notEqual(id(work), id({ ...work, taskClass: 'backend' }))
  assert.notEqual(id(work), id({ ...work, dependsOn: [104] }))
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
  const requestId = agentWorkRequestId(parsed, profile.definitionHash, contractHash, 'Ornn8/example', 40)
  assert.deepEqual(resolveAgentWorkDispatch(body, 40, requestId, profile.definitionHash, contractHash, 'Ornn8/example'), {
    work: parsed,
    branch: 'agent/issue-40',
  })
  assert.throws(
    () => resolveAgentWorkDispatch(agentWork({ ...fields, workflow: 'repair' }), 40, requestId, profile.definitionHash, contractHash, 'Ornn8/example'),
    /changed after dispatch/,
  )
  assert.throws(() => resolveAgentWorkDispatch(body, 40, requestId, '0'.repeat(64), contractHash, 'Ornn8/example'), /changed after dispatch/)
  assert.throws(() => resolveAgentWorkDispatch(body, 40, requestId, profile.definitionHash, contractHash, 'Ornn8/other'), /changed after dispatch/)
  assert.throws(() => resolveAgentWorkDispatch(body, 41, requestId, profile.definitionHash, contractHash, 'Ornn8/example'), /changed after dispatch/)
  assert.throws(() => resolveAgentWorkDispatch(body, 40, requestId, profile.definitionHash, contractHash), /repository/)
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
