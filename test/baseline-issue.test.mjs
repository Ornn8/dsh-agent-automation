import assert from 'node:assert/strict'
import test from 'node:test'
import {
  baselineIssueIdentity,
  baselineIssueWorkItem,
  canonicalIssueUrl,
  ciBaselineIssueFromReceipt,
  nonBaselineBlockFromReceipt,
  trustedBaselineIssue,
} from '../src/baseline-issue.mjs'

const repository = 'Ornn8/deepseek-harness'
const number = 73
const key = 'd15ea5edb00cface'
const workflowName = 'CI'
const url = canonicalIssueUrl(repository, number)
const marker = `<!-- dsh-ci-baseline:v1:${key} -->`

function receipt(overrides = {}) {
  return {
    outcome: 'blocked',
    automationResult: {
      version: 1,
      outcome: 'blocked',
      summary: 'The required check fails unchanged on the default branch.',
      blockedReason: 'ci-baseline',
      issue: { number, url },
    },
    ...overrides,
  }
}

function issue(overrides = {}) {
  return {
    number,
    html_url: url,
    title: `CI baseline: ${workflowName} [${key}]`,
    body: `${marker}\n\nThe default branch reproduces the failure.`,
    state: 'open',
    author_association: 'OWNER',
    labels: [],
    ...overrides,
  }
}

test('CI baseline receipts bind a canonical Issue URL to the configured repository', () => {
  assert.deepEqual(ciBaselineIssueFromReceipt({ receipt: receipt(), repository }), { number, url })
  assert.equal(ciBaselineIssueFromReceipt({ receipt: receipt({ outcome: 'completed' }), repository }), null)
  assert.throws(() => ciBaselineIssueFromReceipt({
    receipt: receipt({ automationResult: { ...receipt().automationResult, issue: { number, url: 'https://github.com/other/repo/issues/73' } } }),
    repository,
  }), /canonical/)
  assert.throws(() => ciBaselineIssueFromReceipt({
    receipt: receipt({ automationResult: { ...receipt().automationResult, extra: true } }), repository,
  }), /unexpected fields/)
})

test('a DSH baseline Issue is itself an actionable work item', () => {
  assert.deepEqual(baselineIssueWorkItem(issue()), {
    workflowName,
    key,
    marker,
    title: issue().title,
  })
  assert.equal(baselineIssueWorkItem(issue({ title: `CI baseline: ${workflowName} [0000000000000000]` })), null)
  assert.equal(baselineIssueWorkItem(issue({ body: '<!-- dsh-ci-baseline:v1:0000000000000000 -->\n' })), null)
})

test('a valid non-baseline DSH block is terminal state rather than an infrastructure failure', () => {
  for (const blockedReason of ['cannot-complete', 'external']) {
    assert.deepEqual(nonBaselineBlockFromReceipt({
      outcome: 'blocked',
      automationResult: {
        version: 1,
        outcome: 'blocked',
        summary: 'The external dependency cannot be reached.',
        blockedReason,
      },
    }), { reason: blockedReason })
  }
  assert.throws(() => nonBaselineBlockFromReceipt(receipt()), /unexpected fields/)
})

test('a baseline Issue must be a trusted unlabeled candidate with a matching marker and English title', () => {
  const verified = trustedBaselineIssue({
    issue: issue(), repository, reference: { number, url }, workflowName,
    branch: 'feature/fix-ci', pullRequestBody: '', trustedAssociation: value => value === 'OWNER',
  })
  assert.equal(verified.identity.key, key)
  assert.deepEqual(baselineIssueIdentity({ workflowName, issueBody: issue().body }), {
    key, marker, title: issue().title,
  })
  assert.throws(() => trustedBaselineIssue({
    issue: issue({ title: 'CI baseline: CI [wrong-title]' }), repository, reference: { number, url }, workflowName,
    branch: 'feature/fix-ci', pullRequestBody: '', trustedAssociation: value => value === 'OWNER',
  }), /title/)
  assert.throws(() => trustedBaselineIssue({
    issue: issue({ labels: [{ name: 'agent/dsh' }] }), repository, reference: { number, url }, workflowName,
    branch: 'feature/fix-ci', pullRequestBody: '', trustedAssociation: value => value === 'OWNER',
  }), /bypass controller admission/)
})

test('a baseline repair cannot redispatch the Issue the current pull request already implements', () => {
  const options = {
    issue: issue(), repository, reference: { number, url }, workflowName,
    trustedAssociation: value => value === 'OWNER',
  }
  assert.throws(() => trustedBaselineIssue({ ...options, branch: `agent/issue-${number}`, pullRequestBody: '' }), /already implementing/)
  assert.throws(() => trustedBaselineIssue({ ...options, branch: 'feature/other', pullRequestBody: `Fixes #${number}` }), /declared to close/)
})
