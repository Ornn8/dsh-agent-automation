import assert from 'node:assert/strict'
import test from 'node:test'
import {
  applySupervisionPlan,
  issueCloseStateReason,
} from '../src/supervision-executor.mjs'

function duplicatePlan() {
  return {
    actions: [{
      type: 'close_issue',
      number: 41,
      reason: 'duplicate',
      duplicateOf: 40,
      fingerprint: 'close-duplicate-41',
      marker: '<!-- repository-supervision:close-duplicate-41 -->',
      evidence: [{
        source: 'issue_state',
        reference: '#40',
        detail: 'Issue #40 already owns the same CI baseline integration work.',
      }],
    }],
    mutationCount: 1,
  }
}

function snapshot(duplicateTitle) {
  return {
    issues: [
      { number: 40, title: '[INFRA] Resolve circular CI baseline repair landing dependency' },
      { number: 41, title: duplicateTitle },
    ],
    pullRequests: [],
    runs: [],
  }
}

test('maps controller duplicate semantics to GitHub not_planned', () => {
  assert.equal(issueCloseStateReason('completed'), 'completed')
  assert.equal(issueCloseStateReason('duplicate'), 'not_planned')
  assert.throws(() => issueCloseStateReason('invalid'), /Unsupported Issue close reason/)
})

test('accepts duplicate closure only when the audited Issues substantially overlap', async () => {
  await assert.doesNotReject(applySupervisionPlan({
    plan: duplicatePlan(),
    snapshot: snapshot('[INFRA] Resolve circular CI baseline repair landing dependency duplicate'),
    repository: 'Ornn8/deepseek-harness',
    config: {},
    environment: {},
    targetCheckout: '.',
    applyChanges: false,
  }))

  await assert.rejects(applySupervisionPlan({
    plan: duplicatePlan(),
    snapshot: snapshot('[GUI-02] Implement the standalone shell'),
    repository: 'Ornn8/deepseek-harness',
    config: {},
    environment: {},
    targetCheckout: '.',
    applyChanges: false,
  }), /does not substantially overlap/)
})
