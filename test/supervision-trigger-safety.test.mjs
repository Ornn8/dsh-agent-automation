import assert from 'node:assert/strict'
import test from 'node:test'
import {
  agentDshEligibility,
  agentDshTriggerSafety,
  planSupervisionActions,
  validateSupervisionProposal,
} from '../src/supervision-protocol.mjs'

function issueBody(dependency = '') {
  return [
    dependency,
    dependency ? '' : undefined,
    'Branch: `agent/gui-02-standalone-shell`',
    '',
    '## Objective',
    '',
    'Implement the standalone shell.',
    '',
    '## Scope',
    '',
    '- Standalone bootstrap only.',
    '',
    '## Requirements',
    '',
    '- Preserve the official WebUI.',
    '',
    '## Acceptance criteria',
    '',
    '- The shell launches.',
    '',
    '## Validation',
    '',
    '- `npm test`',
  ].filter(value => value !== undefined).join('\n')
}

function snapshot({ dependency = '', dependencyState = 'closed' } = {}) {
  return {
    repository: 'Ornn8/deepseek-harness',
    labels: ['agent/dsh'],
    issues: [
      { number: 2, title: '[GUI-01] Baseline', body: issueBody(), state: 'closed', labels: [], comments: [] },
      { number: 3, title: '[GUI-02] Standalone shell', body: issueBody(dependency), state: 'open', labels: ['agent/dsh'], comments: [] },
      { number: 44, title: '[INFRA] Controller pin', body: issueBody(), state: dependencyState, labels: [], comments: [] },
    ],
    branches: [{ name: 'agent/gui-02-standalone-shell', sha: 'a'.repeat(40) }],
    pullRequests: [{
      number: 50,
      state: 'open',
      body: 'Closes #3',
      head: { ref: 'agent/gui-02-standalone-shell', sha: 'b'.repeat(40) },
      comments: [],
    }],
    runs: [{ id: 123, status: 'in_progress', headBranch: 'agent/gui-02-standalone-shell' }],
  }
}

test('active branch, pull request, and run prevent duplicate dispatch without invalidating an existing trigger', () => {
  const state = snapshot()
  const issue = state.issues[1]
  assert.deepEqual(agentDshTriggerSafety(issue, state), { safe: true, reasons: [] })

  const eligibility = agentDshEligibility(issue, state)
  assert.equal(eligibility.eligible, false)
  assert.match(eligibility.reasons.join(' '), /remote branch/)
  assert.match(eligibility.reasons.join(' '), /pull request #50/)
  assert.match(eligibility.reasons.join(' '), /workflow run 123/)
})

test('the controller refuses to stop structurally ready work merely because execution already owns it', () => {
  const state = snapshot()
  const proposal = validateSupervisionProposal({
    version: 1,
    summary: 'Do not stop valid active work.',
    actions: [{
      type: 'remove_label',
      number: 3,
      label: 'agent/dsh',
      fingerprint: 'do-not-stop-active-gui-02',
      evidence: [{ source: 'issue_state', reference: '#3', detail: 'The work already has active ownership.' }],
    }],
  })
  assert.throws(() => planSupervisionActions(proposal, state), /structurally ready/)
})

test('an open declared dependency still makes the existing trigger unsafe', () => {
  const state = snapshot({ dependency: 'Blocked by #44.', dependencyState: 'open' })
  const safety = agentDshTriggerSafety(state.issues[1], state)
  assert.equal(safety.safe, false)
  assert.match(safety.reasons.join(' '), /dependency #44 is still open/)
})
