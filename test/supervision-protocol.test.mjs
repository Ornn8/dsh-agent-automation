import assert from 'node:assert/strict'
import test from 'node:test'
import {
  agentDshEligibility,
  issueTitleSimilarity,
  parseIssueDependencies,
  parseSupervisionMessage,
  planSupervisionActions,
  validateExecutableIssueBody,
  validateSupervisionProposal,
} from '../src/supervision-protocol.mjs'

const issueBody = ({ dependency = '', branch = 'agent/gui-02-standalone-shell' } = {}) => [
  dependency,
  dependency ? '' : undefined,
  `Branch: \`${branch}\``,
  '',
  '## Objective',
  '',
  'Implement one bounded change.',
  '',
  '## Scope',
  '',
  '- One package.',
  '',
  '## Requirements',
  '',
  '- Preserve behavior.',
  '',
  '## Acceptance criteria',
  '',
  '- Tests pass.',
  '',
  '## Validation',
  '',
  '- `npm test`',
  '',
  '## Evidence',
  '',
  '- `src/file.mjs:1` demonstrates the defect.',
].filter(value => value !== undefined).join('\n')

const evidence = [{
  source: 'master',
  reference: 'src/file.mjs:1',
  excerpt: 'const failingPath = true',
  detail: 'The default branch contains the failing path.',
}]

function snapshot(overrides = {}) {
  return {
    repository: 'Ornn8/deepseek-harness',
    labels: ['agent/dsh', 'area/gui'],
    issues: [
      { number: 2, title: '[GUI-01] Baseline', body: issueBody({ branch: 'agent/gui-01' }), state: 'closed', labels: [], comments: [] },
      { number: 3, title: '[GUI-02] Standalone shell', body: issueBody(), state: 'open', labels: [], comments: [] },
    ],
    pullRequests: [],
    runs: [],
    ...overrides,
  }
}

test('parses dependency declarations only from exact independent lines', () => {
  assert.deepEqual(parseIssueDependencies('Depends on #2.\nBlocked by #44.\nDepends on #5 because'), [
    { kind: 'Depends on', number: 2 },
    { kind: 'Blocked by', number: 44 },
  ])
})

test('requires the complete executable Issue structure and an evidence section', () => {
  assert.equal(validateExecutableIssueBody(issueBody()).branch, 'agent/gui-02-standalone-shell')
  assert.throws(() => validateExecutableIssueBody(issueBody().replace('## Objective', '## Goal')), /Objective/)
  assert.throws(() => validateExecutableIssueBody(issueBody().replace('## Evidence\n\n', ''), { requireEvidence: true }), /Evidence/)
  assert.throws(() => validateExecutableIssueBody(issueBody().replace('Branch: `agent/', 'Branch: `gui/')), /Branch/)
})

test('rejects non-English GitHub-visible proposal text', () => {
  assert.throws(() => validateSupervisionProposal({
    version: 1,
    summary: '发现问题',
    actions: [],
  }), /English ASCII/)
})

test('parses one exact terminal supervision payload', () => {
  const value = {
    version: 1,
    summary: 'No unsafe action is required.',
    actions: [],
  }
  assert.deepEqual(parseSupervisionMessage(`Audit complete.\n<!-- repository-supervision-result\n${JSON.stringify(value)}\n-->`), value)
  assert.throws(() => parseSupervisionMessage('No payload'), /must end/)
})

test('blocks agent/dsh while a declared dependency remains open', () => {
  const state = snapshot({
    issues: [
      { number: 2, title: '[GUI-01] Baseline', body: issueBody({ branch: 'agent/gui-01' }), state: 'closed', labels: [], comments: [] },
      { number: 3, title: '[GUI-02] Standalone shell', body: issueBody({ dependency: 'Blocked by #44.' }), state: 'open', labels: [], comments: [] },
      { number: 44, title: '[INFRA] Controller', body: issueBody({ branch: 'agent/controller' }), state: 'open', labels: [], comments: [] },
    ],
  })
  const result = agentDshEligibility(state.issues[1], state)
  assert.equal(result.eligible, false)
  assert.match(result.reasons.join(' '), /#44 is still open/)
})

test('blocks agent/dsh when an open pull request or active run already owns the branch', () => {
  const state = snapshot({
    pullRequests: [{ number: 20, state: 'open', body: 'Closes #3', head: { ref: 'agent/gui-02-standalone-shell' }, comments: [] }],
    runs: [{ id: 99, status: 'in_progress', headBranch: 'agent/gui-02-standalone-shell' }],
  })
  const result = agentDshEligibility(state.issues[1], state)
  assert.equal(result.eligible, false)
  assert.match(result.reasons.join(' '), /pull request #20/)
  assert.match(result.reasons.join(' '), /workflow run 99/)
})

test('uses explicit Issue dependencies instead of repository-specific sequencing', () => {
  const state = snapshot({ issues: [
    { number: 2, title: '[GUI-01] Baseline', body: issueBody({ branch: 'agent/gui-01' }), state: 'open', labels: [], comments: [] },
    { number: 3, title: '[GUI-02] Standalone shell', body: issueBody(), state: 'open', labels: [], comments: [] },
  ] })
  assert.deepEqual(agentDshEligibility(state.issues[1], state), { eligible: true, reasons: [] })
  state.issues[1].body = issueBody({ dependency: 'Depends on #2.' })
  assert.match(agentDshEligibility(state.issues[1], state).reasons.join(' '), /dependency #2 is still open/)
})

test('requires an exact source excerpt for file and upstream evidence', () => {
  const proposal = {
    version: 1,
    summary: 'Create one evidence-backed Issue.',
    actions: [{
      type: 'create_issue',
      fingerprint: 'missing-source-excerpt',
      title: '[BUG] Missing source excerpt',
      body: issueBody({ branch: 'agent/missing-source-excerpt' }),
      labels: [],
      evidence: [{ source: 'master', reference: 'src/file.mjs:1', detail: 'A real path alone is insufficient evidence.' }],
    }],
  }
  assert.throws(() => validateSupervisionProposal(proposal), /excerpt/)
})

test('allows agent/dsh only for a complete ready Issue', () => {
  const state = snapshot()
  assert.deepEqual(agentDshEligibility(state.issues[1], state), { eligible: true, reasons: [] })
  const proposal = validateSupervisionProposal({
    version: 1,
    summary: 'GUI-02 is ready to execute.',
    actions: [{
      type: 'add_label',
      number: 3,
      label: 'agent/dsh',
      fingerprint: 'dispatch-gui-02',
      evidence: [{ source: 'issue_state', reference: '#2', detail: 'The predecessor is closed.' }],
    }],
  })
  assert.equal(planSupervisionActions(proposal, state).mutationCount, 1)
})

test('plans a blocked-trigger correction as two bounded mutations', () => {
  const state = snapshot({ issues: [
    { number: 2, title: '[GUI-01] Baseline', body: issueBody({ branch: 'agent/gui-01' }), state: 'closed', labels: [], comments: [] },
    { number: 3, title: '[GUI-02] Standalone shell', body: issueBody({ dependency: 'Blocked by #44.' }), state: 'open', labels: ['agent/dsh'], comments: [] },
    { number: 44, title: '[INFRA] Controller', body: issueBody({ branch: 'agent/controller' }), state: 'open', labels: [], comments: [] },
  ] })
  const proposal = validateSupervisionProposal({
    version: 1,
    summary: 'Remove the unsafe execution trigger.',
    actions: [{
      type: 'remove_label',
      number: 3,
      label: 'agent/dsh',
      fingerprint: 'block-gui-02-controller',
      evidence: [{ source: 'issue_state', reference: '#44', detail: 'The declared dependency is open.' }],
    }],
  })
  const plan = planSupervisionActions(proposal, state)
  assert.equal(plan.mutationCount, 2)
  assert.match(plan.actions[0].blockingReasons.join(' '), /#44 is still open/)
})

test('rejects duplicate or substantially overlapping Issue creation', () => {
  assert.ok(issueTitleSimilarity('[BUG] Static asset errors', '[WEB] Static asset error handling') >= 0.72)
  const state = snapshot({ issues: [{
    number: 11,
    title: '[BUG] Static asset errors',
    body: issueBody({ branch: 'agent/static-errors' }),
    state: 'closed',
    labels: [],
    comments: [],
  }] })
  const proposal = validateSupervisionProposal({
    version: 1,
    summary: 'Create one evidence-backed Issue.',
    actions: [{
      type: 'create_issue',
      fingerprint: 'static-asset-error-handling',
      title: '[WEB] Static asset error handling',
      body: issueBody({ branch: 'agent/static-asset-errors' }),
      labels: [],
      evidence,
    }],
  })
  assert.throws(() => planSupervisionActions(proposal, state), /duplicates or substantially overlaps/)
})

test('makes repeated marker-bearing audits idempotent', () => {
  const state = snapshot({ issues: [{
    number: 3,
    title: '[GUI-02] Standalone shell',
    body: issueBody(),
    state: 'open',
    labels: [],
    comments: [{ body: '<!-- repository-supervision:status-gui-02 -->\nCurrent state is recorded.' }],
  }] })
  const proposal = validateSupervisionProposal({
    version: 1,
    summary: 'Record current state.',
    actions: [{
      type: 'comment_issue',
      number: 3,
      fingerprint: 'status-gui-02',
      body: 'Current state is recorded.',
      evidence: [{ source: 'issue_state', reference: '#3', detail: 'The Issue remains open.' }],
    }],
  })
  assert.deepEqual(planSupervisionActions(proposal, state), { actions: [], mutationCount: 0 })
})

test('fails closed when implicit blocked correction exceeds the mutation cap', () => {
  const state = snapshot({ issues: [
    { number: 2, title: '[GUI-01] Baseline', body: issueBody({ branch: 'agent/gui-01' }), state: 'closed', labels: [], comments: [] },
    { number: 3, title: '[GUI-02] Standalone shell', body: issueBody({ dependency: 'Blocked by #44.' }), state: 'open', labels: ['agent/dsh'], comments: [] },
    { number: 44, title: '[INFRA] Controller', body: issueBody({ branch: 'agent/controller' }), state: 'open', labels: [], comments: [] },
  ] })
  const proposal = validateSupervisionProposal({
    version: 1,
    summary: 'Correct an unsafe trigger.',
    actions: [{
      type: 'remove_label', number: 3, label: 'agent/dsh', fingerprint: 'block-cap-test',
      evidence: [{ source: 'issue_state', reference: '#44', detail: 'The dependency is open.' }],
    }],
  })
  assert.throws(() => planSupervisionActions(proposal, state, { maxMutations: 1 }), /exceeding/)
})
