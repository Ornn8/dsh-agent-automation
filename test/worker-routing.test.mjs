import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import {
  classifyAndCreateWorkerRouteDecision,
  classifyWorkRequest,
  createWorkerRouteDecision,
  createWorkerRoutingExecution,
  parseWorkerRouteDecision,
  parseWorkerRoutingExecution,
  parseWorkerRouteDecisionBody,
  serializeWorkerRouteDecision,
  workerRouteDecisionBody,
} from '../src/worker-routing.mjs'

const stateVersion = 'c'.repeat(64)
const routingFixture = fileURLToPath(new URL('./fixtures/worker-routing-process.mjs', import.meta.url))
const capacityFixture = fileURLToPath(new URL('./fixtures/capacity-store-process.mjs', import.meta.url))
const workRequest = {
  version: 2,
  requestId: 'agent-work-example',
  role: 'change',
  profileId: 'example-profile',
  workflowId: 'default',
  stageId: 'change',
  definitionHash: 'a'.repeat(64),
  repository: 'owner/repository',
  subject: { type: 'issue', number: 121 },
  revision: { base: 'b'.repeat(40), head: 'b'.repeat(40) },
  coordinationKey: 'owner/repository:example-profile:default',
}

// Worker ids are intentionally absent. The fixture proves route classes without selecting a provider.
const routingPolicy = {
  version: 1,
  default: 'default',
  classificationOrder: ['frontend'],
  routes: {
    frontend: {
      rules: {
        any: [
          { labelsAny: ['ui'] },
          { pathPrefixes: ['web/'] },
          { extensions: ['.tsx', '.css'] },
          { workflowStages: ['frontend'] },
        ],
      },
    },
    default: { rules: {} },
  },
}

const deploymentFixture = {
  workers: {
    'antigravity-gemini-flash': { provider: 'antigravity', model: 'gemini-flash-3.7' },
    'dsh-deepseek-v4-flash': { provider: 'opencode-go', model: 'deepseek-v4-flash' },
  },
  routes: {
    frontend: {
      selectors: [{ worker: 'antigravity-gemini-flash' }],
      rules: { labelsAny: ['ui'] },
    },
    default: {
      selectors: [{ worker: 'dsh-deepseek-v4-flash' }],
      rules: {},
    },
  },
}

function classify(options = {}) {
  return classifyWorkRequest({ workRequest, stateVersion, ...options })
}

async function runRoutingProcess(stateRoot) {
  const child = spawn(process.execPath, [routingFixture, stateRoot], { stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''
  child.stdout.on('data', chunk => { stdout += chunk })
  const [result] = await once(child, 'close')
  return { code: result, output: JSON.parse(stdout) }
}

test('trusted route class wins before bounded deterministic rules', () => {
  const result = classify({
    workRequest,
    routingPolicy,
    trustedTaskSnapshot: { routeClass: 'frontend', labels: ['backend'] },
  })
  assert.equal(result.taskClass, 'frontend')
  assert.equal(result.source, 'trusted-route')
  assert.match(result.policyHash, /^[0-9a-f]{64}$/)
  assert.match(result.evidenceHash, /^[0-9a-f]{64}$/)
})

test('deterministic rules classify bounded trusted labels, paths, and stages', () => {
  for (const snapshot of [
    { labels: [{ name: 'ui' }] },
    { changedPaths: ['web/components/Button.tsx'] },
    { stageId: 'frontend' },
  ]) {
    const result = classify({ workRequest, routingPolicy, trustedTaskSnapshot: snapshot })
    assert.deepEqual(
      { taskClass: result.taskClass, source: result.source },
      { taskClass: 'frontend', source: 'deterministic-rules' },
    )
  }
})

test('missing failure evidence does not match failure rules or block default fallback', () => {
  const result = classify({
    routingPolicy: {
      routes: {
        frontend: { rules: { failureClasses: ['capacity'] } },
        default: {},
      },
      classifier: () => { throw new Error('classifier unavailable') },
    },
    trustedTaskSnapshot: { labels: ['unrelated'] },
  })
  assert.deepEqual(
    { taskClass: result.taskClass, source: result.source },
    { taskClass: 'default', source: 'default' },
  )
})

test('unknown, malformed, asynchronous, and low-confidence classifiers use deterministic default', () => {
  const cases = [
    () => 'unknown-route',
    () => Promise.resolve('frontend'),
    () => ({ taskClass: 'frontend', confidence: 0.2 }),
    () => { throw new Error('classifier unavailable') },
  ]
  for (const classifier of cases) {
    const result = classify({
      workRequest,
      routingPolicy: { ...routingPolicy, classifier },
      trustedTaskSnapshot: { labels: ['unrelated'] },
    })
    assert.deepEqual(
      { taskClass: result.taskClass, source: result.source },
      { taskClass: 'default', source: 'default' },
    )
  }
})

test('rejected asynchronous classifier falls back without an unhandled rejection', async () => {
  let unhandled
  const observeUnhandled = reason => { unhandled = reason }
  process.on('unhandledRejection', observeUnhandled)
  try {
    const result = classify({
      routingPolicy: {
        ...routingPolicy,
        classifier: () => Promise.reject(new Error('classifier rejected')),
      },
      trustedTaskSnapshot: { labels: ['unrelated'] },
    })
    assert.deepEqual(
      { taskClass: result.taskClass, source: result.source },
      { taskClass: 'default', source: 'default' },
    )
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(unhandled, undefined)
  } finally {
    process.removeListener('unhandledRejection', observeUnhandled)
  }
})

test('optional classifier may select only a configured route class', () => {
  const result = classify({
    workRequest,
    routingPolicy: {
      ...routingPolicy,
      classifierMinimumConfidence: 0.7,
      classifier: () => ({ taskClass: 'frontend', confidence: 0.9 }),
    },
    trustedTaskSnapshot: { labels: ['unrelated'] },
  })
  assert.equal(result.taskClass, 'frontend')
  assert.equal(result.source, 'optional-classifier')
})

test('classification policy bounds recursive rule depth', () => {
  let rule = { labelsAny: ['ui'] }
  for (let depth = 0; depth < 6; depth += 1) rule = { any: [rule] }
  assert.throws(
    () => classify({ workRequest, routingPolicy: { routes: { frontend: { rules: rule }, default: {} } } }),
    /maximum rule depth/,
  )
})

test('classification hashes are stable and change when trusted evidence changes', () => {
  const first = classify({ workRequest, routingPolicy, trustedTaskSnapshot: { labels: ['ui'] } })
  const reordered = classify({ workRequest, routingPolicy, trustedTaskSnapshot: { labels: ['ui'], paths: [] } })
  const changed = classify({ workRequest, routingPolicy, trustedTaskSnapshot: { labels: ['backend'] } })
  assert.equal(first.policyHash, reordered.policyHash)
  assert.equal(first.evidenceHash, reordered.evidenceHash)
  assert.notEqual(first.evidenceHash, changed.evidenceHash)
})

test('classification accepts the PR1 role routing object without importing Worker identity', () => {
  const result = classify({
    workRequest,
    routingPolicy: { change: { maxCandidates: 8, routes: { default: { selectors: [{ worker: 'machine-local-id' }] } } } },
    trustedTaskSnapshot: { labels: ['unrelated'] },
  })
  assert.deepEqual({ taskClass: result.taskClass, source: result.source }, { taskClass: 'default', source: 'default' })
})

test('deployment fixture maps frontend and default workers outside the WorkRequest', () => {
  const frontend = classify({
    workRequest,
    routingPolicy: { routes: deploymentFixture.routes, classificationOrder: ['frontend'] },
    trustedTaskSnapshot: { labels: ['ui'] },
  })
  const fallback = classify({
    workRequest,
    routingPolicy: { routes: deploymentFixture.routes, classificationOrder: ['frontend'] },
    trustedTaskSnapshot: { labels: ['backend'] },
  })
  assert.equal(frontend.taskClass, 'frontend')
  assert.equal(fallback.taskClass, 'default')
  assert.equal(workRequest.workerId, undefined)
  assert.equal(frontend.workerId, undefined)
  assert.equal(frontend.provider, undefined)
  assert.equal(frontend.model, undefined)
})

test('WorkerRouteDecision v1 binds request id, role, exact state, class, and hashes', () => {
  const decision = classifyAndCreateWorkerRouteDecision({
    workRequest,
    subjectStateVersion: stateVersion,
    routingPolicy,
    trustedTaskSnapshot: { labels: ['ui'] },
  })
  assert.deepEqual(Object.keys(decision).sort(), [
    'evidenceHash', 'policyHash', 'role', 'stateVersion', 'taskClass', 'version', 'workRequestId',
  ])
  assert.equal(decision.workRequestId, workRequest.requestId)
  assert.equal(decision.role, workRequest.role)
  assert.equal(decision.stateVersion, stateVersion)
  assert.equal(decision.taskClass, 'frontend')
  assert.equal(parseWorkerRouteDecision(decision, { workRequest, stateVersion }).workRequestId, workRequest.requestId)
  assert.throws(
    () => parseWorkerRouteDecision(decision, { workRequest: { ...workRequest, requestId: 'other-request' } }),
    /does not match the WorkRequest/,
  )
  assert.throws(
    () => parseWorkerRouteDecision(decision, { stateVersion: 'd'.repeat(64) }),
    /does not match the subject/,
  )
  const classification = classify({ workRequest, routingPolicy, trustedTaskSnapshot: { labels: ['ui'] } })
  assert.deepEqual(
    { workRequestId: classification.workRequestId, role: classification.role, stateVersion: classification.stateVersion },
    { workRequestId: workRequest.requestId, role: workRequest.role, stateVersion },
  )
  assert.equal(
    createWorkerRouteDecision({
      workRequest,
      subjectState: { stateVersion },
      classification,
    }).stateVersion,
    stateVersion,
  )
  assert.throws(
    () => createWorkerRouteDecision({
      workRequest: { ...workRequest, requestId: 'other-request' },
      stateVersion,
      classification,
    }),
    /classification does not match the WorkRequest/,
  )
  assert.throws(
    () => createWorkerRouteDecision({
      workRequest: { ...workRequest, role: 'review' },
      stateVersion,
      classification,
    }),
    /classification does not match the WorkRequest/,
  )
  assert.throws(
    () => createWorkerRouteDecision({
      workRequest,
      stateVersion: 'd'.repeat(64),
      classification,
    }),
    /classification does not match the exact subject state/,
  )
  assert.throws(
    () => classifyWorkRequest({ workRequest, routingPolicy, trustedTaskSnapshot: { labels: ['ui'] } }),
    /requires an exact subject state version/,
  )
  for (const conflictingState of [
    { subjectStateVersion: stateVersion, stateVersion: 'd'.repeat(64) },
    { subjectStateVersion: stateVersion, subjectState: 'd'.repeat(64) },
    { stateVersion, subjectState: { stateVersion: 'd'.repeat(64) } },
    { subjectState: { stateVersion, version: 'd'.repeat(64) } },
  ]) {
    assert.throws(
      () => classifyWorkRequest({
        workRequest,
        routingPolicy,
        trustedTaskSnapshot: { labels: ['ui'] },
        ...conflictingState,
      }),
      /Exact subject state version inputs must agree/,
    )
  }
  assert.equal(classifyWorkRequest({
    workRequest,
    routingPolicy,
    trustedTaskSnapshot: { labels: ['ui'] },
    subjectStateVersion: stateVersion,
    stateVersion,
    subjectState: { stateVersion, version: stateVersion },
  }).stateVersion, stateVersion)
  assert.throws(
    () => createWorkerRouteDecision({
      workRequest,
      subjectStateVersion: stateVersion,
      stateVersion: 'd'.repeat(64),
      classification,
    }),
    /Exact subject state version inputs must agree/,
  )
})

test('local routing records use the canonical process lease across concurrent workers and recover after a crash', { timeout: 60_000 }, async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'dsh-routing-process-lock-'))
  try {
    const crashed = spawn(process.execPath, [capacityFixture, 'crash', stateRoot, 'routing-crash'], { stdio: ['ignore', 'pipe', 'pipe'] })
    const [crashCode] = await once(crashed, 'close')
    assert.equal(crashCode, 17)

    const results = await Promise.all([runRoutingProcess(stateRoot), runRoutingProcess(stateRoot), runRoutingProcess(stateRoot)])
    assert.deepEqual(results.map(result => result.code), [0, 0, 0])
    assert.equal(new Set(results.map(result => result.output.routingAttemptId)).size, 1)

    const recordNames = await readdir(join(stateRoot, 'worker-routing'))
    assert.equal(recordNames.length, 1)
    assert.match(recordNames[0], /^[a-f0-9]{64}\.json$/)
    const record = JSON.parse(await readFile(join(stateRoot, 'worker-routing', recordNames[0]), 'utf8'))
    assert.equal(record.routingAttemptId, results[0].output.routingAttemptId)
    assert.doesNotMatch(recordNames[0], /\.lock$/)
  } finally {
    await rm(stateRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})

test('controller-owned routing execution binds a non-default decision and generation', () => {
  const execution = createWorkerRoutingExecution({
    routingAttemptId: 'review-generation-7',
    workRequest,
    subjectStateVersion: stateVersion,
    routingPolicy,
    trustedTaskSnapshot: { labels: ['ui'] },
  })
  assert.equal(execution.version, 1)
  assert.equal(execution.routingAttemptId, 'review-generation-7')
  assert.equal(execution.routeDecision.taskClass, 'frontend')
  assert.deepEqual(parseWorkerRoutingExecution(execution, {
    workRequest,
    subjectStateVersion: stateVersion,
    routingPolicy,
  }), execution)
  assert.throws(() => parseWorkerRoutingExecution({
    ...execution,
    routeDecision: { ...execution.routeDecision, workRequestId: 'other-request' },
  }, { workRequest, subjectStateVersion: stateVersion, routingPolicy }), /does not match the WorkRequest/)
  assert.throws(() => parseWorkerRoutingExecution({ ...execution, routingAttemptId: 'bad id' }), /routingAttemptId/)
})

test('durable decision serialization and body parsing remain strict', () => {
  const classification = classify({ workRequest, routingPolicy, trustedTaskSnapshot: { labels: ['ui'] } })
  const decision = createWorkerRouteDecision({ workRequest, stateVersion, classification, routingPolicy })
  const serialized = serializeWorkerRouteDecision(decision)
  assert.equal(serialized, serializeWorkerRouteDecision(JSON.parse(serialized)))
  const body = workerRouteDecisionBody(decision)
  assert.deepEqual(parseWorkerRouteDecisionBody(body, { workRequest, stateVersion }), decision)
  assert.deepEqual(parseWorkerRouteDecision(decision, { routingPolicy }), decision)
  assert.throws(() => parseWorkerRouteDecision({ ...decision, concreteWorker: 'worker-a' }), /unknown field/)
  assert.throws(
    () => parseWorkerRouteDecision({ ...decision, taskClass: 'backend' }, { routingPolicy }),
    /not configured by routingPolicy/,
  )
  const [marker, durableJson, trailer] = body.split('\n')
  for (const invalidBody of [
    `${durableJson}\n${trailer}`,
    `${marker}\n${durableJson}`,
    `${trailer}\n${durableJson}\n${marker}`,
    `${marker}${body}`,
    `${body}${trailer}`,
    `${body}\n${body}`,
    `prefix${body}`,
    `${body}suffix`,
  ]) {
    assert.throws(() => parseWorkerRouteDecisionBody(invalidBody), /one exact durable v1 record/)
  }
  const members = Object.entries(decision)
    .map(([key, value]) => `${JSON.stringify(key)}:${JSON.stringify(value)}`)
  const conflictingValues = {
    version: 2,
    workRequestId: 'other-request',
    role: 'review',
    stateVersion: 'd'.repeat(64),
    taskClass: 'default',
    policyHash: 'd'.repeat(64),
    evidenceHash: 'd'.repeat(64),
  }
  for (const key of Object.keys(decision)) {
    const duplicate = `{${members.join(',')},${JSON.stringify(key)}:${JSON.stringify(conflictingValues[key])}}`
    assert.throws(
      () => parseWorkerRouteDecisionBody(body.replace(serialized, duplicate)),
      new RegExp(`duplicate JSON member ${key}`),
    )
  }
  const escapedDuplicate = `{${members.join(',')},"\\u0072ole":${JSON.stringify(decision.role)}}`
  assert.throws(
    () => parseWorkerRouteDecisionBody(body.replace(serialized, escapedDuplicate)),
    /duplicate JSON member role/,
  )
  assert.throws(
    () => parseWorkerRouteDecisionBody(body.replace(serialized, '{"outer":{"value":1,"value":2}}')),
    /duplicate JSON member value/,
  )
  assert.throws(() => createWorkerRouteDecision({
    workRequest,
    stateVersion,
    classification,
    routingPolicy: { ...routingPolicy, classifierMinimumConfidence: 0.9 },
  }), /policyHash does not match/)
})

test('classification and decision never add a concrete Worker to the WorkRequest', () => {
  const decision = classifyAndCreateWorkerRouteDecision({
    workRequest,
    stateVersion,
    routingPolicy,
    trustedTaskSnapshot: { labels: ['ui'] },
  })
  assert.equal(workRequest.workerId, undefined)
  assert.equal(decision.workerId, undefined)
  assert.equal(decision.provider, undefined)
  assert.equal(decision.model, undefined)
})
