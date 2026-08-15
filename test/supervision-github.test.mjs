import assert from 'node:assert/strict'
import test from 'node:test'
import { githubPages } from '../src/supervision-github.mjs'
import { loadRelevantWorkflowRuns } from '../src/supervision-snapshot.mjs'

test('reads every bounded GitHub page and fails closed when the third page is full', async () => {
  const requested = []
  const values = Array.from({ length: 102 }, (_, index) => ({ id: index + 1 }))
  const result = await githubPages({
    path: 'repos/example/project/issues?state=open',
    description: 'open Issues',
    request: async ({ path }) => {
      requested.push(path)
      const page = Number(new URL(path, 'https://api.github.invalid/').searchParams.get('page'))
      return values.slice((page - 1) * 100, page * 100)
    },
  })
  assert.deepEqual(result, values)
  assert.equal(requested.length, 2)
  assert.match(requested[0], /per_page=100/)
  assert.match(requested[1], /page=2/)

  await assert.rejects(githubPages({
    path: 'repos/example/project/branches',
    description: 'branches',
    request: async () => Array.from({ length: 100 }, (_, index) => ({ id: index + 1 })),
  }), /exceeded the 3-page audit limit/)
})

test('merges paginated GitHub envelope arrays and honors their total count', async () => {
  const values = Array.from({ length: 200 }, (_, index) => ({ id: index + 1 }))
  const result = await githubPages({
    path: 'repos/example/project/actions/runs',
    description: 'workflow runs',
    collection: 'workflow_runs',
    request: async ({ path }) => {
      const page = Number(new URL(path, 'https://api.github.invalid/').searchParams.get('page'))
      return { total_count: values.length, workflow_runs: values.slice((page - 1) * 100, page * 100) }
    },
  })
  assert.equal(result.total_count, 200)
  assert.deepEqual(result.workflow_runs, values)
})

test('repository workflow snapshot bounds history but includes every active status', async () => {
  const requestedStatuses = []
  const recent = [
    { id: 1, created_at: '2026-08-15T10:00:00Z', status: 'completed' },
    { id: 2, created_at: '2026-08-15T09:00:00Z', status: 'queued' },
  ]
  const active = {
    queued: [{ id: 2, created_at: '2026-08-15T09:00:00Z', status: 'queued' }],
    in_progress: [{ id: 3, created_at: '2026-08-14T09:00:00Z', status: 'in_progress' }],
    requested: [],
    waiting: [],
    pending: [],
  }
  const result = await loadRelevantWorkflowRuns({
    repository: 'example/project',
    request: async ({ path }) => {
      assert.equal(path, 'repos/example/project/actions/runs?per_page=100')
      return { workflow_runs: recent }
    },
    pages: async ({ path, collection }) => {
      assert.equal(collection, 'workflow_runs')
      const status = new URL(path, 'https://api.github.invalid/').searchParams.get('status')
      requestedStatuses.push(status)
      return { workflow_runs: active[status] }
    },
  })
  assert.deepEqual(requestedStatuses, ['queued', 'in_progress', 'requested', 'waiting', 'pending'])
  assert.deepEqual(result.map(run => run.id), [1, 2, 3])
})

test('repository workflow snapshot rejects a malformed recent response', async () => {
  await assert.rejects(loadRelevantWorkflowRuns({
    repository: 'example/project',
    request: async () => ({ total_count: 2 }),
    pages: async () => ({ workflow_runs: [] }),
  }), /Recent workflow runs did not return a workflow_runs array/)
})
