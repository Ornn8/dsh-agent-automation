import assert from 'node:assert/strict'
import test from 'node:test'
import {
  applySupervisionPlan,
  issueCloseStateReason,
  validateSupervisionEvidence,
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

test('binds master and pull request evidence to the referenced line excerpt', async () => {
  const masterAction = {
    type: 'create_issue',
    evidence: [{ source: 'master', reference: 'src/master.mjs:2', excerpt: 'const masterDefect = true', detail: 'The defect is live.' }],
  }
  const runCommand = async (_command, args) => {
    assert.deepEqual(args.slice(-2), ['show', 'HEAD:src/master.mjs'])
    return { stdout: 'const safe = true\nconst masterDefect = true\n' }
  }
  await assert.doesNotReject(validateSupervisionEvidence(masterAction, { pullRequests: [] }, {
    config: { gitExecutable: 'git' }, targetCheckout: '.', environment: {}, repository: 'example/project', runCommand,
  }))
  await assert.rejects(validateSupervisionEvidence({
    ...masterAction,
    evidence: [{ ...masterAction.evidence[0], excerpt: 'const inventedDefect = true' }],
  }, { pullRequests: [] }, {
    config: { gitExecutable: 'git' }, targetCheckout: '.', environment: {}, repository: 'example/project', runCommand,
  }), /does not match line 2/)

  const pullRequestAction = {
    type: 'comment_pr',
    number: 7,
    evidence: [{ source: 'pull_request', reference: '#7:src/pr.mjs:2', excerpt: 'const prDefect = true', detail: 'The pull request introduces the defect.' }],
  }
  const pullRequestSnapshot = {
    pullRequests: [{
      number: 7,
      head: { sha: 'a'.repeat(40) },
      files: [{ path: 'src/pr.mjs', patch: '@@ -2 +2 @@\n-const prDefect = false\n+const prDefect = true' }],
    }],
  }
  await assert.doesNotReject(validateSupervisionEvidence(pullRequestAction, pullRequestSnapshot, {
    config: {}, targetCheckout: '.', environment: {}, repository: 'example/project',
    githubRequest: async () => ({ encoding: 'base64', content: Buffer.from('const safe = true\nconst prDefect = true\n').toString('base64') }),
  }))
})

test('binds upstream evidence to a source line in an upstream-only commit', async () => {
  const commit = 'b'.repeat(40)
  const upstreamHead = 'c'.repeat(40)
  const action = {
    type: 'create_issue',
    evidence: [{
      source: 'upstream', reference: `sha:${commit}:src/upstream.mjs:2`, excerpt: 'const upstreamChange = true', detail: 'The upstream-only commit introduces this path.',
    }],
  }
  const runCommand = async (_command, args) => {
    if (args.includes('--format=')) {
      return { stdout: '@@ -2 +2 @@\n-const upstreamChange = false\n+const upstreamChange = true\n' }
    }
    if (args.includes('show')) return { stdout: 'const safe = true\nconst upstreamChange = true\n' }
    if (args.at(-1) === 'refs/remotes/repository-supervision/upstream') return { stdout: `${commit}\n` }
    if (args.at(-1) === 'HEAD') return { stdout: `${'d'.repeat(40)}\n` }
    throw new Error(`Unexpected git arguments: ${args.join(' ')}`)
  }
  await assert.doesNotReject(validateSupervisionEvidence(action, {
    upstream: { headSha: upstreamHead, gitRef: 'refs/remotes/repository-supervision/upstream', behind: 2 },
    pullRequests: [],
  }, {
    config: { gitExecutable: 'git' }, targetCheckout: '.', environment: {}, repository: 'example/project', runCommand,
  }))
})

test('revalidates each Issue or pull request immediately before its mutation', async () => {
  const calls = []
  const auditedIssue = {
    number: 1, state: 'open', stateReason: null, updatedAt: '2026-01-01T00:00:00Z', title: 'Issue', body: 'Body', labels: [],
  }
  const auditedPullRequest = {
    number: 7, state: 'open', draft: false, updatedAt: '2026-01-01T00:00:00Z', mergedAt: null, closedAt: null,
    title: 'Pull request', body: 'Body', labels: [], head: { ref: 'feature', sha: 'a'.repeat(40) }, base: { ref: 'main', sha: 'b'.repeat(40) }, files: [],
  }
  const githubRequest = async ({ path, method }) => {
    calls.push(`${method || 'GET'} ${path}`)
    if (!method && path.endsWith('/issues/1')) {
      return { number: 1, state: 'open', state_reason: null, updated_at: auditedIssue.updatedAt, title: 'Issue', body: 'Body', labels: [] }
    }
    if (!method && path.endsWith('/pulls/7')) {
      return {
        number: 7, state: 'open', draft: false, updated_at: auditedPullRequest.updatedAt, merged_at: null, closed_at: null,
        title: 'Pull request', body: 'Body', labels: [], head: { ref: 'feature', sha: auditedPullRequest.head.sha }, base: { ref: 'main', sha: auditedPullRequest.base.sha },
      }
    }
    return {}
  }
  await applySupervisionPlan({
    plan: {
      mutationCount: 2,
      actions: [
        {
          type: 'comment_issue', number: 1, marker: '<!-- repository-supervision:issue-comment -->', body: 'Issue comment.',
          evidence: [{ source: 'issue_state', reference: '#1', detail: 'The Issue is open.' }],
        },
        {
          type: 'comment_pr', number: 7, marker: '<!-- repository-supervision:pr-comment -->', body: 'Pull request comment.',
          evidence: [{ source: 'ci', reference: 'run:9', detail: 'The audited workflow failed.' }],
        },
      ],
    },
    snapshot: { issues: [auditedIssue], pullRequests: [auditedPullRequest], runs: [{ id: 9, conclusion: 'failure' }] },
    repository: 'example/project', config: {}, environment: {}, targetCheckout: '.', applyChanges: true, githubRequest,
  })
  assert.deepEqual(calls, [
    'GET repos/example/project/issues/1',
    'POST repos/example/project/issues/1/comments',
    'GET repos/example/project/pulls/7',
    'POST repos/example/project/issues/7/comments',
  ])
})

test('stops the plan before writing when a mutation target changed', async () => {
  const calls = []
  await assert.rejects(applySupervisionPlan({
    plan: {
      mutationCount: 1,
      actions: [{
        type: 'comment_issue', number: 1, marker: '<!-- repository-supervision:stale-issue -->', body: 'Stale comment.',
        evidence: [{ source: 'issue_state', reference: '#1', detail: 'The audited Issue was open.' }],
      }],
    },
    snapshot: {
      issues: [{ number: 1, state: 'open', stateReason: null, updatedAt: '2026-01-01T00:00:00Z', title: 'Before', body: 'Body', labels: [] }],
      pullRequests: [], runs: [],
    },
    repository: 'example/project', config: {}, environment: {}, targetCheckout: '.', applyChanges: true,
    githubRequest: async ({ path, method }) => {
      calls.push(`${method || 'GET'} ${path}`)
      return { number: 1, state: 'open', state_reason: null, updated_at: '2026-01-02T00:00:00Z', title: 'After', body: 'Body', labels: [] }
    },
  }), /changed before its supervision mutation/)
  assert.deepEqual(calls, ['GET repos/example/project/issues/1'])
})

test('revalidates a blocked Issue between label removal and its comment', async () => {
  const auditedIssue = {
    number: 4, state: 'open', stateReason: null, updatedAt: '2026-01-01T00:00:00Z',
    title: 'Blocked work', body: 'Body', labels: ['agent/dsh'],
  }
  const calls = []
  const githubRequest = async ({ path, method }) => {
    calls.push(`${method || 'GET'} ${path}`)
    if (!method && path.endsWith('/issues/4')) {
      const afterRemoval = calls.some(call => call.startsWith('DELETE '))
      return {
        number: 4, state: 'open', state_reason: null,
        updated_at: afterRemoval ? '2026-01-01T00:01:00Z' : auditedIssue.updatedAt,
        title: 'Blocked work', body: 'Body', labels: afterRemoval ? [] : [{ name: 'agent/dsh' }],
      }
    }
    return {}
  }
  await applySupervisionPlan({
    plan: {
      mutationCount: 2,
      actions: [{
        type: 'remove_label', number: 4, label: 'agent/dsh', commentRequired: true,
        marker: '<!-- repository-supervision:blocked -->', blockingReasons: ['dependency #3 is open'],
        evidence: [{ source: 'issue_state', reference: '#4', detail: 'The declared dependency remains open.' }],
      }],
    },
    snapshot: { issues: [auditedIssue], pullRequests: [] },
    repository: 'example/project', config: {}, environment: {}, targetCheckout: '.', applyChanges: true, githubRequest,
  })
  assert.deepEqual(calls, [
    'GET repos/example/project/issues/4',
    'DELETE repos/example/project/issues/4/labels/agent%2Fdsh',
    'GET repos/example/project/issues/4',
    'POST repos/example/project/issues/4/comments',
  ])
})
