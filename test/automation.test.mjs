import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import {
  actionsCredentialEnvironment,
  hostCredentialEnvironment,
  issueBranch,
  removeJobDirectory,
  trustedAssociation,
} from '../src/common.mjs'
import {
  ciRepairRequest,
  explicitReworkCommand,
  issueDependencies,
  selectBacklogWork,
  trustedCiFailure,
  trustedReviewFeedback,
} from '../src/dispatch-policy.mjs'
import {
  automaticRepairRequestId,
  githubReviewBody,
  hasExactReviewVerdict,
  parseReviewMessage,
} from '../src/review-protocol.mjs'
import { localDshWebBaseUrl, runDshWebSession } from '../src/dsh-web-session.mjs'
import { reviewTaskIdsToArchive } from '../src/codex-session.mjs'

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
      case 'session.prompt': return rpcResponse(request, { accepted: true })
      case 'session.cancel': return rpcResponse(request, { accepted: true })
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

test('DSH Web session is titled, prompted once, and observed to completion', async () => {
  const fake = visibleSessionFetch()
  let created
  const result = await runDshWebSession({
    baseUrl: 'http://127.0.0.1:3080',
    cwd: 'F:\\runner\\checkout',
    title: '[DSH] 修复 PR #12',
    prompt: 'Do the work.',
    fetchImpl: fake.fetchImpl,
    sleep: async () => undefined,
    onCreated: async value => { created = value },
  })
  assert.deepEqual(result, { sessionId: 'session-visible', reason: 'completed' })
  assert.deepEqual(created, { sessionId: 'session-visible' })
  assert.deepEqual(fake.calls.map(call => call.method), [
    'session.create', 'session.rename', 'session.prompt',
    'session.list', 'session.list', 'session.history',
  ])
  assert.equal(fake.calls[2].payload.content[0].text, 'Do the work.')
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

test('DSH Web session timeout cancels the controller-owned turn', async () => {
  const fake = visibleSessionFetch()
  const times = [0, 0, 2, 2]
  await assert.rejects(runDshWebSession({
    baseUrl: 'http://127.0.0.1:3080',
    cwd: 'F:\\runner\\checkout',
    title: '[DSH] 修复 PR #12',
    prompt: 'Do the work.',
    timeoutMs: 1,
    fetchImpl: fake.fetchImpl,
    sleep: async () => undefined,
    now: () => times.shift() ?? 2,
  }), /timed out/)
  assert.equal(fake.calls.at(-1).method, 'session.cancel')
})

test('Codex retention archives automated review tasks beyond six', () => {
  const threads = Array.from({ length: 8 }, (_, index) => ({
    id: `review-${index}`,
    title: `[GitHub Review] PR #12 @head-${index}`,
  }))
  threads.push({ id: 'control', title: '设置 PR 自动审核合并' })
  assert.deepEqual(reviewTaskIdsToArchive(threads, 'review-0', 6), ['review-6', 'review-7'])
})

test('a blocking review publishes an independent change work request', async () => {
  const reviewWorkflow = await readFile(new URL('../.github/workflows/codex-review.yml', import.meta.url), 'utf8')
  const workflow = await readFile(new URL('../.github/workflows/dsh-repair.yml', import.meta.url), 'utf8')
  assert.match(reviewWorkflow, /Publish an independent change work request/)
  assert.match(reviewWorkflow, /node controller\/src\/publish-work-request\.mjs/)
  assert.doesNotMatch(reviewWorkflow, /node controller\/src\/dsh-repair\.mjs/)
  assert.match(reviewWorkflow, /runner_labels_json:/)
  assert.match(workflow, /runner_labels_json:/)
  assert.doesNotMatch(workflow, /workflow_dispatch:/)
  assert.match(workflow, /controller_sha:/)
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

test('backlog dispatch leaves failed or active repairs for their explicit recovery path', () => {
  const pullRequest = {
    number: 10,
    draft: false,
    head: { sha: 'head10', repo: { full_name: 'Ornn8/deepseek-harness' } },
    labels: [
      { name: 'automation/review-blocked' },
      { name: 'agent/dsh-failed' },
    ],
  }
  assert.equal(selectBacklogWork({
    repository: 'Ornn8/deepseek-harness', pullRequests: [pullRequest], issues: [],
  }), null)

  pullRequest.labels = [
    { name: 'automation/review-blocked' },
    { name: 'automation/repairing' },
  ]
  assert.equal(selectBacklogWork({
    repository: 'Ornn8/deepseek-harness', pullRequests: [pullRequest], issues: [],
  }), null)
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

test('trusted blocking GitHub reviews and inline comments wake DSH without a mention', () => {
  assert.equal(trustedReviewFeedback({
    kind: 'review', association: 'OWNER', state: 'CHANGES_REQUESTED',
  }), true)
  assert.equal(trustedReviewFeedback({
    kind: 'review-comment', association: 'COLLABORATOR',
  }), true)
  assert.equal(trustedReviewFeedback({
    kind: 'review', association: 'OWNER', state: 'APPROVED',
  }), false)
  assert.equal(trustedReviewFeedback({
    kind: 'review-comment', association: 'CONTRIBUTOR',
  }), false)
})

test('CI repair requests bind one failed CI run or one bootstrap head', () => {
  assert.deepEqual(ciRepairRequest('ci-run-31767661165-2'), {
    kind: 'run', runId: 31767661165, attempt: 2,
  })
  assert.deepEqual(ciRepairRequest(`ci-head-${'a'.repeat(40)}`), {
    kind: 'head', head: 'a'.repeat(40),
  })
  assert.equal(ciRepairRequest('ci-run-not-a-number-1'), null)
  assert.equal(ciRepairRequest('ci-head-main'), null)
})

test('only an exact failed CI pull request run may wake DSH', () => {
  const run = {
    id: 31767661165,
    run_attempt: 2,
    name: 'CI',
    event: 'pull_request',
    status: 'completed',
    conclusion: 'failure',
    head_sha: 'a'.repeat(40),
    pull_requests: [{ number: 12 }],
  }
  assert.equal(trustedCiFailure({ run, pullRequestNumber: 12, expectedHead: 'a'.repeat(40) }), true)
  assert.equal(trustedCiFailure({ run: { ...run, name: 'Agent PR Review' }, pullRequestNumber: 12, expectedHead: 'a'.repeat(40) }), false)
  assert.equal(trustedCiFailure({ run: { ...run, conclusion: 'cancelled' }, pullRequestNumber: 12, expectedHead: 'a'.repeat(40) }), false)
  assert.equal(trustedCiFailure({ run, pullRequestNumber: 13, expectedHead: 'a'.repeat(40) }), false)
  assert.equal(trustedCiFailure({ run, pullRequestNumber: 12, expectedHead: 'b'.repeat(40) }), false)
})

test('trustedAssociation limits privileged dispatch', () => {
  assert.equal(trustedAssociation('OWNER'), true)
  assert.equal(trustedAssociation('MEMBER'), true)
  assert.equal(trustedAssociation('COLLABORATOR'), true)
  assert.equal(trustedAssociation('CONTRIBUTOR'), false)
  assert.equal(trustedAssociation('NONE'), false)
})

test('review publication and agent execution use different GitHub credentials', () => {
  const source = { GITHUB_TOKEN: 'actions-token', GH_TOKEN: 'host-token', PATH: 'bin' }
  assert.deepEqual(actionsCredentialEnvironment({}, source), {
    GITHUB_TOKEN: 'actions-token', GH_TOKEN: 'actions-token', PATH: 'bin',
  })
  assert.deepEqual(hostCredentialEnvironment({}, source), { PATH: 'bin' })
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

test('parseReviewMessage reads a collapsible automation result after Chinese prose', () => {
  const review = parseReviewMessage('结论：通过。\n\n<details>\n<summary>Automation result</summary>\n\n```json\n{"verdict":"pass","summary":"No blocking defects.","findings":[]}\n```\n</details>')
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

test('automatic repair requests are idempotent for one exact review pair', () => {
  const base = 'a'.repeat(40)
  const head = 'b'.repeat(40)
  assert.equal(automaticRepairRequestId(base, head), `codex-${base}-${head}`)
  assert.throws(() => automaticRepairRequestId('main', head), /full commit SHA/)
})

test('a recorded BLOCK is not mislabeled as review automation failure', () => {
  const head = 'a'.repeat(40)
  assert.equal(hasExactReviewVerdict([{ body: `<!-- codex-review:${head} -->\n## Codex review: BLOCK` }], head), true)
  assert.equal(hasExactReviewVerdict([{ body: '<!-- codex-review:other -->' }], head), false)
})
