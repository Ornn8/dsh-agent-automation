import assert from 'node:assert/strict'
import test from 'node:test'
import { selectExactHeadCi } from '../src/coordinator-v2/pr-ci-snapshot.mjs'

const headSha = 'a'.repeat(40)
const oldHeadSha = 'b'.repeat(40)
const requiredChecks = [
  { name: 'build', appId: 10 },
  { name: 'lint', appId: 11 },
]
const run = (id, name, appId, overrides = {}) => ({
  id,
  name,
  appId,
  headSha,
  status: 'completed',
  conclusion: 'success',
  ...overrides,
})
const select = (checkRuns, overrides = {}) => selectExactHeadCi({
  headSha,
  requiredChecks,
  checkSnapshot: { complete: true, headSha, checkRuns },
  ...overrides,
})

test('uses the newest exact-head app-bound CheckRun for every required identity', () => {
  const result = select([
    run(1, 'build', 10, { headSha: oldHeadSha }),
    run(2, 'build', 10),
    run(3, 'build', 10, { status: 'in_progress', conclusion: null }),
    run(4, 'lint', 11, { conclusion: 'neutral' }),
    run(5, 'lint', 99),
  ])
  assert.deepEqual(result, {
    status: 'ok',
    ci: {
      headSha,
      status: 'pending',
      checks: [
        { name: 'build', appId: 10, status: 'pending', checkRunId: 3 },
        { name: 'lint', appId: 11, status: 'passed', checkRunId: 4 },
      ],
    },
  })
})

test('aggregates passed, failed, and missing required checks without trusting same-name other-App results', () => {
  assert.equal(select([run(1, 'build', 10), run(2, 'lint', 11, { conclusion: 'skipped' })]).ci.status, 'passed')

  const failed = select([
    run(1, 'build', 10),
    run(2, 'build', 10, { conclusion: 'failure' }),
    run(3, 'lint', 11),
  ])
  assert.equal(failed.status, 'ok')
  assert.equal(failed.ci.status, 'failed')
  assert.equal(failed.ci.checks[0].checkRunId, 2)

  const missing = select([run(1, 'build', 99), run(2, 'lint', 11)])
  assert.equal(missing.status, 'ok')
  assert.deepEqual(missing.ci.checks[0], {
    name: 'build', appId: 10, status: 'missing', checkRunId: null,
  })
  assert.equal(missing.ci.status, 'pending')
})

test('deduplicates identical ids and rejects contradictory observations independent of input order', () => {
  const duplicate = run(9, 'build', 10)
  const left = select([run(10, 'lint', 11), duplicate, { ...duplicate }])
  const right = select([{ ...duplicate }, duplicate, run(10, 'lint', 11)].reverse(), {
    requiredChecks: [...requiredChecks].reverse(),
  })
  assert.deepEqual(left, right)

  for (const checkRuns of [
    [duplicate, { ...duplicate, conclusion: 'failure' }],
    [{ ...duplicate, conclusion: 'failure' }, duplicate],
  ]) {
    const result = select(checkRuns)
    assert.equal(result.status, 'invalid')
    assert.match(result.detail, /conflicting observations/i)
  }
})

test('fails closed on incomplete, mismatched, unbounded, and malformed snapshots', () => {
  const cases = [
    { headSha, requiredChecks, checkSnapshot: { complete: false, headSha, checkRuns: [] } },
    { headSha, requiredChecks, checkSnapshot: { complete: true, headSha: oldHeadSha, checkRuns: [] } },
    { headSha, requiredChecks: [], checkSnapshot: { complete: true, headSha, checkRuns: [] } },
    { headSha, requiredChecks: [requiredChecks[0], requiredChecks[0]], checkSnapshot: { complete: true, headSha, checkRuns: [] } },
    { headSha, requiredChecks, checkSnapshot: { complete: true, headSha, checkRuns: [run(1, 'build', 10, { status: 'completed', conclusion: null })] } },
    { headSha, requiredChecks, checkSnapshot: { complete: true, headSha, checkRuns: [run(1, 'build', 10, { status: 'in_progress', conclusion: 'success' })] } },
    { headSha, requiredChecks, checkSnapshot: { complete: true, headSha, checkRuns: [{ headSha, name: 'build', appId: 10 }] } },
    { headSha, requiredChecks, checkSnapshot: { complete: true, headSha, checkRuns: Array.from({ length: 2_049 }, (_, id) => run(id + 1, 'build', 10)) } },
  ]
  for (const input of cases) {
    const result = selectExactHeadCi(input)
    assert.equal(result.status, 'invalid')
    assert.equal(result.reason, 'invalid-input')
  }
  const unrelatedNoise = select(Array.from({ length: 5_000 }, (_, id) => run(id + 1, 'noise', 99)))
  assert.equal(unrelatedNoise.status, 'ok')
  assert.equal(unrelatedNoise.ci.status, 'pending')
})

test('is deterministic under CheckRun input permutations', () => {
  const checks = [
    run(1, 'build', 10),
    run(2, 'build', 10, { status: 'queued', conclusion: null }),
    run(3, 'lint', 11),
    run(4, 'noise', 12),
    run(5, 'build', 10, { headSha: oldHeadSha }),
  ]
  const expected = select(checks)
  for (let iteration = 0; iteration < 100; iteration += 1) {
    const offset = iteration % checks.length
    const shuffled = [...checks.slice(offset), ...checks.slice(0, offset)]
    if (iteration % 2) shuffled.reverse()
    assert.deepEqual(select(shuffled), expected)
  }
})

test('rejects unknown fields and non-object or function-shaped inputs', () => {
  const functionInput = function input() {}
  Object.assign(functionInput, {
    headSha,
    requiredChecks,
    checkSnapshot: { complete: true, headSha, checkRuns: [] },
  })
  for (const input of [
    null,
    [],
    functionInput,
    { headSha, requiredChecks, checkSnapshot: { complete: true, headSha, checkRuns: [] }, extra: true },
    { headSha, requiredChecks: [{ name: 'build', appId: '10' }], checkSnapshot: { complete: true, headSha, checkRuns: [] } },
  ]) {
    const result = selectExactHeadCi(input)
    assert.equal(result.status, 'invalid')
  }
})
