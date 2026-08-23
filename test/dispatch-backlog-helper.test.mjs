import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import {
  parseMaximumBatchSize,
  runBacklogBatch,
  selectBacklogDispatches,
} from '../src/dispatch-backlog-helper.mjs'

test('requested wake selects exactly one item through the single-item path', () => {
  const calls = []
  const selections = selectBacklogDispatches({
    requestedIssueNumber: 7,
    selectSingle: () => { calls.push('single'); return { type: 'issue', number: 7 } },
    selectBatch: () => { calls.push('batch'); return [{ type: 'issue', number: 4 }, { type: 'issue', number: 7 }] },
  })

  assert.deepEqual(selections, [{ type: 'issue', number: 7 }])
  assert.deepEqual(calls, ['single'])
})

test('ordinary scans preserve the policy batch order', () => {
  const calls = []
  const selections = selectBacklogDispatches({
    selectSingle: () => { calls.push('single'); return { type: 'issue', number: 9 } },
    selectBatch: () => { calls.push('batch'); return [{ type: 'issue', number: 4 }, { type: 'issue', number: 9 }] },
  })

  assert.deepEqual(selections.map(selection => selection.number), [4, 9])
  assert.deepEqual(calls, ['batch'])
})

test('batch size accepts only a positive safe integer and defaults to four', () => {
  assert.equal(parseMaximumBatchSize(undefined), 4)
  assert.equal(parseMaximumBatchSize('2'), 2)
  assert.throws(() => parseMaximumBatchSize('0'), /positive safe integer/)
  assert.throws(() => parseMaximumBatchSize('4.5'), /positive integer/)
})

test('dispatch backlog exposes the bounded reusable batch input', async () => {
  const workflow = await readFile(new URL('../.github/workflows/dispatch-backlog.yml', import.meta.url), 'utf8')
  assert.match(workflow, /maximum_batch_size:[\s\S]*default: 4[\s\S]*type: number/)
  assert.match(workflow, /MAXIMUM_BATCH_SIZE: \$\{\{ inputs\.maximum_batch_size \}\}/)
})

test('dispatch backlog provisions its control label before editing or dispatching', async () => {
  const source = await readFile(new URL('../src/dispatch-backlog.mjs', import.meta.url), 'utf8')
  const worker = await readFile(new URL('../src/dsh-issue.mjs', import.meta.url), 'utf8')
  const create = source.indexOf("'label', 'create', 'agent/dsh'")
  const add = source.indexOf("'issue', 'edit', String(work.number), '--repo', repository, '--add-label', 'agent/dsh'")
  const dispatch = source.indexOf("'api', '--method', 'POST', `repos/${repository}/dispatches`", add)
  const applied = source.indexOf('await recordApplied(work, admission)')

  assert.notEqual(create, -1)
  assert.notEqual(add, -1)
  assert.notEqual(dispatch, -1)
  assert.notEqual(applied, -1)
  assert.ok(create < add)
  assert.ok(add < dispatch)
  assert.ok(dispatch < applied)
  assert.match(source, /const requestId = agentWorkRequestId\(work\.work, profile\.definitionHash/)
  assert.match(source, /repositoryDispatchBody\(work\.request\)/)
  assert.match(worker, /const validExisting = existing\.find\(/)
  assert.match(worker, /if \(validExisting\)/)
  assert.match(source.slice(create, add), /'--description', 'A ready Issue is queued for DSH execution'/)
  assert.match(source.slice(create, add), /'--color', '1D76DB', '--force'/)
  assert.doesNotMatch(source.slice(create, add), /\.catch\(/)
})

test('batch runner attempts stable members independently and surfaces aggregate failure', async () => {
  const attempts = []
  const applied = []
  const retryable = []
  await assert.rejects(runBacklogBatch(
    [{ type: 'issue', number: 2 }, { type: 'issue', number: 5 }],
    async selection => {
      attempts.push(selection.number)
      try {
        if (selection.number === 2) throw new Error('first failed')
        applied.push(selection.number)
        return { status: 'applied' }
      } catch (error) {
        retryable.push(selection.number)
        throw error
      }
    },
  ), error => {
    assert.equal(error.name, 'AggregateError')
    assert.deepEqual(error.outcomes.map(outcome => [outcome.number, outcome.status]), [
      [2, 'failed'], [5, 'applied'],
    ])
    return true
  })
  assert.deepEqual(attempts, [2, 5])
  assert.deepEqual(applied, [5])
  assert.deepEqual(retryable, [2])
})
