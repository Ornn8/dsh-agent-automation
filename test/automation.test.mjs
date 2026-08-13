import assert from 'node:assert/strict'
import { mkdtemp, mkdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { issueBranch, removeJobDirectory, trustedAssociation } from '../src/common.mjs'
import {
  explicitReworkCommand,
  issueDependencies,
  selectBacklogWork,
} from '../src/dispatch-policy.mjs'
import { githubReviewBody, parseReviewMessage } from '../src/review-protocol.mjs'
import { localDshWebBaseUrl, runDshWebSession } from '../src/dsh-web-session.mjs'

function rpcResponse(request, value, ok = true) {
  return {
    ok: true,
    status: 200,
    async json() {
      return {
        type: 'server-response',
        rpcId: request.rpcId,
        result: ok ? { ok: true, value } : { ok: false, error: value },
      }
    },
  }
}

function visibleSessionFetch(reason = 'completed') {
  const calls = []
  let lists = 0
  const fetchImpl = async (_url, options) => {
    const request = JSON.parse(options.body)
    calls.push(request)
    switch (request.method) {
      case 'session.create': return rpcResponse(request, { sessionId: 'session-visible' })
      case 'session.rename': return rpcResponse(request, { title: request.payload.title, seq: 1 })
      case 'session.prompt': return rpcResponse(request, request.payload.content[0].text.startsWith('/permission')
        ? { accepted: true, command: { kind: 'success', text: 'preset danger-full-access' } }
        : { accepted: true })
      case 'session.list': {
        lists += 1
        return rpcResponse(request, { items: [{ sessionId: 'session-visible', running: lists === 1 }] })
      }
      case 'session.history': return rpcResponse(request, {
        events: [{ event: { type: 'turn/end', data: { reason: { kind: reason } } } }],
      })
      default: throw new Error(`Unexpected method ${request.method}`)
    }
  }
  return { calls, fetchImpl }
}

test('DSH Web sessions stay on the loopback Host', () => {
  assert.equal(localDshWebBaseUrl('http://localhost:3080'), 'http://localhost:3080')
  assert.throws(() => localDshWebBaseUrl('https://example.com'), /loopback/)
})

test('DSH Web session is titled, privileged, prompted, and observed to completion', async () => {
  const fake = visibleSessionFetch()
  const result = await runDshWebSession({
    baseUrl: 'http://127.0.0.1:3080',
    cwd: 'F:\\runner\\checkout',
    title: '[DSH] 修复 PR #12',
    prompt: 'Do the work.',
    fetchImpl: fake.fetchImpl,
    sleep: async () => undefined,
  })
  assert.deepEqual(result, { sessionId: 'session-visible', reason: 'completed' })
  assert.deepEqual(fake.calls.map(call => call.method), [
    'session.create', 'session.rename', 'session.prompt', 'session.prompt',
    'session.list', 'session.list', 'session.history',
  ])
  assert.equal(fake.calls[2].payload.content[0].text, '/permission danger-full-access')
  assert.equal(fake.calls[3].payload.content[0].text, 'Do the work.')
})

test('DSH Web session interruption fails the controller', async () => {
  const fake = visibleSessionFetch('interrupted')
  await assert.rejects(runDshWebSession({
    baseUrl: 'http://127.0.0.1:3080',
    cwd: 'F:\\runner\\checkout',
    title: '[DSH] 修复 PR #12',
    prompt: 'Do the work.',
    fetchImpl: fake.fetchImpl,
    sleep: async () => undefined,
  }), /ended with interrupted/)
})

test('issueBranch accepts the documented branch field', () => {
  assert.equal(issueBranch('## Completion\nBranch: `gui/02-shell`\n'), 'gui/02-shell')
  assert.equal(issueBranch('- Branch name: `agent/fix_1`'), 'agent/fix_1')
})

test('issueBranch rejects missing or unsafe branches', () => {
  assert.throws(() => issueBranch('No branch here'), /must declare/)
  assert.throws(() => issueBranch('Branch: `../master`'), /unsafe/)
  assert.throws(() => issueBranch('Branch: `topic@{1}`'), /unsafe/)
})

test('issueBranch gives trusted bug dispatch a deterministic fallback', () => {
  assert.equal(issueBranch('No branch here', { number: 11 }), 'agent/issue-11')
})

test('issueDependencies reads blocking dependency prose only', () => {
  assert.deepEqual(issueDependencies('Parent: #1\n\nBlocked by #2. Do not claim.'), [2])
  assert.deepEqual(issueDependencies('Depends on #7. Continue after merge.'), [7])
  assert.deepEqual(issueDependencies('Closes #9'), [])
})

test('backlog dispatch repairs blocked pull requests before starting Issues', () => {
  const work = selectBacklogWork({
    repository: 'Ornn8/deepseek-harness',
    pullRequests: [{
      number: 10,
      draft: false,
      head: { sha: 'head10', repo: { full_name: 'Ornn8/deepseek-harness' } },
      labels: [{ name: 'automation/review-blocked' }],
    }],
    issues: [{
      number: 3,
      state: 'open',
      title: '[GUI-02] Shell',
      body: 'Blocked by #2.\nBranch: `gui/02-shell`',
      author_association: 'OWNER',
      labels: [],
    }],
  })
  assert.deepEqual(work, { type: 'repair', number: 10, head: 'head10' })
})

test('backlog dispatch waits for open dependencies and skips trackers', () => {
  const issues = [
    {
      number: 1,
      state: 'open',
      title: '[GUI-00] Standalone GUI tracker',
      body: 'Parent tracker only.',
      author_association: 'OWNER',
      labels: [],
    },
    {
      number: 2,
      state: 'open',
      title: '[GUI-01] Architecture',
      body: 'Branch: `gui/01-architecture`',
      author_association: 'OWNER',
      labels: [{ name: 'agent/dsh' }],
    },
    {
      number: 3,
      state: 'open',
      title: '[GUI-02] Shell',
      body: 'Blocked by #2.\nBranch: `gui/02-shell`',
      author_association: 'OWNER',
      labels: [],
    },
    {
      number: 11,
      state: 'open',
      title: '[BUG] Static I/O error',
      body: 'A focused bug report without a branch field.',
      author_association: 'OWNER',
      labels: [],
    },
  ]
  assert.deepEqual(selectBacklogWork({
    repository: 'Ornn8/deepseek-harness', pullRequests: [], issues,
  }), { type: 'issue', number: 11 })

  issues[1].state = 'closed'
  assert.deepEqual(selectBacklogWork({
    repository: 'Ornn8/deepseek-harness', pullRequests: [], issues,
  }), { type: 'issue', number: 3 })
})

test('explicit rework commands are deliberate and case insensitive', () => {
  assert.equal(explicitReworkCommand('@dsh fix the lifecycle finding'), true)
  assert.equal(explicitReworkCommand('DSH: rework this PR'), true)
  assert.equal(explicitReworkCommand('Looks good to me'), false)
  assert.equal(explicitReworkCommand('<!-- dsh-review-result -->'), false)
})

test('trustedAssociation limits privileged dispatch', () => {
  assert.equal(trustedAssociation('OWNER'), true)
  assert.equal(trustedAssociation('MEMBER'), true)
  assert.equal(trustedAssociation('COLLABORATOR'), true)
  assert.equal(trustedAssociation('CONTRIBUTOR'), false)
  assert.equal(trustedAssociation('NONE'), false)
})

test('removeJobDirectory cannot escape its declared root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-automation-root-'))
  const child = join(root, 'child')
  await mkdir(child)
  await removeJobDirectory(root, child)
  await assert.rejects(stat(child))
  await assert.rejects(removeJobDirectory(root, root), /Refusing/)
  await assert.rejects(removeJobDirectory(root, join(root, '..')), /Refusing/)
})

test('parseReviewMessage reads a hidden passing result after Chinese prose', () => {
  const review = parseReviewMessage('结论：通过。\n\n<!-- dsh-review-result\n{"verdict":"pass","summary":"No blocking defects.","findings":[]}\n-->')
  assert.deepEqual(review, { verdict: 'pass', summary: 'No blocking defects.', findings: [] })
})

test('parseReviewMessage fails closed on inconsistent results', () => {
  assert.throws(() => parseReviewMessage('plain text'), /does not end/)
  assert.throws(() => parseReviewMessage('x\n<!-- dsh-review-result\n{"verdict":"block","summary":"Blocked.","findings":[]}\n-->'), /must contain/)
})

test('githubReviewBody stays English and binds the reviewed commits', () => {
  const body = githubReviewBody({ verdict: 'pass', summary: 'No blockers.', findings: [] }, {
    marker: '<!-- marker -->',
    base: 'base123',
    head: 'head456',
  })
  assert.match(body, /Codex review: PASS/)
  assert.match(body, /head456.*base123/)
})
