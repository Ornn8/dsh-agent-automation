import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { createIssueCapacityWaitProjection } from '../src/capacity-wait-projection.mjs'
import { createCapacityRecord, projectWorkerCapacityIdentity, scopeCapacityIdentity } from '../src/capacity-registry.mjs'
import { capacityRecordKey } from '../src/capacity-registry-store.mjs'
import { resolveMachineConfig } from '../src/machine-config.mjs'
import { createStageWorkRequest } from '../src/work-request.mjs'
import { parseWorkflowDefinition, workflowDefinitionHash } from '../src/workflow-definition.mjs'
import { createWorkerRouteDecision } from '../src/worker-routing.mjs'
import {
  evaluateCapacityWaitResume,
  evaluateCapacityWaitResumeAndDispatch,
} from '../src/capacity-resume-policy.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const stateVersion = 'a'.repeat(64)
const base = 'b'.repeat(40)
const now = Date.parse('2026-01-01T00:00:00.000Z')

async function fixture() {
  const [profileText, defaultsText, configText] = await Promise.all([
    readFile(new URL('../profiles/github-pr-cycle/profile.json', import.meta.url), 'utf8'),
    readFile(new URL('../ops/config.defaults.json', import.meta.url), 'utf8'),
    readFile(new URL('../config.minimal.json', import.meta.url), 'utf8'),
  ])
  const definition = parseWorkflowDefinition(JSON.parse(profileText))
  const definitionHash = workflowDefinitionHash(definition)
  const workRequest = createStageWorkRequest({
    definition,
    definitionHash,
    workflowId: 'default',
    stageId: 'change',
    repository: 'Ornn8/target',
    subject: { type: 'issue', number: 17 },
    revision: { base, head: base },
    coordinationKey: 'Ornn8/target:github-pr-cycle:default',
    requestId: 'issue-request-17',
  })
  const routeDecision = createWorkerRouteDecision({
    workRequest,
    stateVersion,
    classification: {
      version: 1,
      workRequestId: workRequest.requestId,
      role: workRequest.role,
      stateVersion,
      taskClass: 'default',
      policyHash: 'c'.repeat(64),
      evidenceHash: 'd'.repeat(64),
      source: 'default',
    },
  })
  const projection = createIssueCapacityWaitProjection({
    workRequest,
    issueNumber: 17,
    subjectStateVersion: stateVersion,
    routeDecision,
    capacityGenerationHash: 'e'.repeat(64),
    observationId: 'run-100',
  })
  const input = JSON.parse(configText)
  input.workers.change.routingTags = ['capacity']
  input.operations.roles.change.workers = ['change']
  input.operations.routing = { change: { routes: { default: { selectors: [{ allTags: ['capacity'] }] } } } }
  const defaults = JSON.parse(defaultsText)
  const previousMachineConfig = resolveMachineConfig({ defaults, input, configurationPath: `${root}/config.minimal.json` })
  const currentInput = structuredClone(input)
  currentInput.workers.change2 = { ...currentInput.workers.change, routingTags: ['capacity'] }
  currentInput.operations.roles.change.workers = ['change', 'change2']
  const currentMachineConfig = resolveMachineConfig({
    defaults,
    input: currentInput,
    configurationPath: `${root}/config.minimal.json`,
  })
  const record = (config, workerId, state = 'available', scope = 'capacity-group') => {
    const worker = config.workers[workerId]
    const identity = projectWorkerCapacityIdentity(workerId, worker)
    const available = createCapacityRecord({
      capacityGroup: worker.capacityGroup,
      scope,
      sourceWorker: workerId,
      capacityIdentity: identity,
      configurationHash: 'f'.repeat(64),
      credentialGeneration: '1',
      now,
    })
    return state === 'available'
      ? available
      : { ...available, state, reason: 'quota-exhausted', retryAtUtc: new Date(now + 60_000).toISOString(), generation: 1 }
  }
  const plan = (config, workerId, records = [], options = {}) => {
    const worker = config.workers[workerId]
    const identity = projectWorkerCapacityIdentity(workerId, worker)
    const entries = records.map(({ record: value, requiresProbe = false }) => ({
      key: capacityRecordKey({ capacityGroup: worker.capacityGroup, scope: value.scope, identity: value.capacityIdentity }),
      scope: value.scope,
      record: value,
      requiresProbe,
      identity: scopeCapacityIdentity(value.scope, identity),
    }))
    const probeScopes = options.probeScopes ?? entries.filter(entry => entry.requiresProbe).map(entry => entry.scope)
    return {
      workerId,
      capacityGroup: worker.capacityGroup,
      identity,
      eligible: options.eligible ?? entries.every(entry => entry.record.state === 'available'),
      startState: options.startState ?? (probeScopes.length ? 'half-open' : entries.every(entry => entry.record.state === 'available') ? 'available' : 'cooldown'),
      capacityGeneration: Math.max(0, ...entries.map(entry => entry.record.generation)),
      records: entries,
      probeScopes,
    }
  }
  return {
    definition,
    definitionHash,
    workRequest,
    projection,
    currentSubject: { type: 'issue', number: 17, stateVersion, revision: { base, head: base } },
    previousMachineConfig,
    currentMachineConfig,
    previousCapacity: { generationHash: '1'.repeat(64), plans: [plan(previousMachineConfig, 'change', [{ record: record(previousMachineConfig, 'change', 'cooldown') }])] },
    currentCapacity: {
      generationHash: '2'.repeat(64),
      plans: [
        plan(currentMachineConfig, 'change', [{ record: record(currentMachineConfig, 'change', 'cooldown') }]),
        plan(currentMachineConfig, 'change2'),
      ],
    },
    record,
    plan,
    now,
  }
}

function evaluate(input, overrides = {}) {
  return evaluateCapacityWaitResume({
    projection: input.projection,
    workRequest: input.workRequest,
    profile: { definition: input.definition, definitionHash: input.definitionHash },
    currentSubject: input.currentSubject,
    currentRouteDecision: input.projection.routeDecision,
    machineConfig: input.currentMachineConfig,
    capacitySnapshot: input.currentCapacity,
    now: input.now,
    ...overrides,
  })
}

test('a newly added matching Worker makes an existing Issue wait resume-eligible', async () => {
  const input = await fixture()
  const before = evaluate(input, { machineConfig: input.previousMachineConfig, capacitySnapshot: input.previousCapacity })
  const after = evaluate(input)

  assert.equal(before.decision, 'deferred')
  assert.equal(after.decision, 'resume')
  assert.deepEqual(after.availableCandidates, ['change2'])
  assert.equal(input.currentCapacity.plans.find(plan => plan.workerId === 'change2').records.length, 0)
  assert.equal(after.capacityResumeRequestId, before.capacityResumeRequestId)
  assert.equal(after.capacityResumeRequestId, evaluate(input).capacityResumeRequestId)
})

test('stale Issue revision and changed route decision cannot resume a wait', async () => {
  const input = await fixture()
  assert.equal(evaluate(input, {
    currentSubject: { ...input.currentSubject, revision: { base: 'c'.repeat(40), head: base } },
  }).decision, 'stale')
  assert.equal(evaluate(input, {
    currentRouteDecision: { ...input.projection.routeDecision, taskClass: 'other' },
  }).decision, 'stale')
  assert.equal(evaluate(input, {
    profile: { definition: input.definition, definitionHash: 'f'.repeat(64) },
  }).decision, 'stale')
})

test('identical inputs produce one bounded decision and missing capacity is stale', async () => {
  const input = await fixture()
  const first = evaluate(input)
  const second = evaluate({
    ...input,
    projection: structuredClone(input.projection),
    workRequest: structuredClone(input.workRequest),
    definition: structuredClone(input.definition),
    currentSubject: structuredClone(input.currentSubject),
    currentMachineConfig: structuredClone(input.currentMachineConfig),
    currentCapacity: structuredClone(input.currentCapacity),
  })
  assert.deepEqual(second, first)
  assert.deepEqual(Object.keys(first).sort(), [
    'availableCandidates', 'capacityGenerationHash', 'capacityResumeRequestId', 'currentCandidates',
    'decision', 'reason', 'version',
  ])
  assert.equal(evaluate(input, { capacitySnapshot: undefined }).decision, 'stale')
})

test('a shared capacity-group cooldown blocks an otherwise available Worker', async () => {
  const input = await fixture()
  const sharedConfig = structuredClone(input.currentMachineConfig)
  sharedConfig.workers.change2.capacityGroup = 'change'
  const plans = [
    input.plan(sharedConfig, 'change', [{ record: input.record(sharedConfig, 'change', 'cooldown') }]),
    input.plan(sharedConfig, 'change2', [
      { record: input.record(sharedConfig, 'change2', 'cooldown') },
      { record: input.record(sharedConfig, 'change2', 'available', 'worker') },
    ]),
  ]
  assert.equal(evaluate(input, { machineConfig: sharedConfig, capacitySnapshot: { generationHash: '3'.repeat(64), plans } }).decision, 'deferred')
})

test('a probe-needed plan stays deferred until its half-open lease is claimed', async () => {
  const input = await fixture()
  const expired = input.record(input.currentMachineConfig, 'change2', 'cooldown')
  expired.retryAtUtc = new Date(input.now - 1).toISOString()
  const plans = [
    input.plan(input.currentMachineConfig, 'change', [{ record: input.record(input.currentMachineConfig, 'change', 'cooldown') }]),
    input.plan(input.currentMachineConfig, 'change2', [{ record: expired, requiresProbe: true }], {
      eligible: true, startState: 'half-open', probeScopes: ['capacity-group'],
    }),
  ]
  assert.equal(evaluate(input, { capacitySnapshot: { generationHash: '4'.repeat(64), plans } }).decision, 'deferred')
})

test('a missing or mismatched current candidate plan fails closed', async () => {
  const input = await fixture()
  assert.equal(evaluate(input, {
    capacitySnapshot: { generationHash: '5'.repeat(64), plans: input.currentCapacity.plans.slice(0, 1) },
  }).decision, 'stale')
  const mismatched = structuredClone(input.currentCapacity.plans)
  mismatched[1].capacityGroup = 'other-group'
  assert.equal(evaluate(input, { capacitySnapshot: { generationHash: '6'.repeat(64), plans: mismatched } }).decision, 'stale')
})

test('resume dispatches the exact WorkRequest and route identity', async () => {
  const workRequest = {
    version: 2, requestId: 'issue-request-17', profileId: 'github-pr-cycle', workflowId: 'issue-work', stageId: 'change',
    definitionHash: 'a'.repeat(64), role: 'change', repository: 'Ornn8/deepseek-harness', subject: { type: 'issue', number: 17 },
    revision: { base: 'b'.repeat(40), head: 'b'.repeat(40) }, coordinationKey: 'Ornn8/deepseek-harness:github-pr-cycle:issue-work',
  }
  const routeDecision = {
    version: 1, workRequestId: workRequest.requestId, role: 'change', stateVersion: 'c'.repeat(64), taskClass: 'default',
    policyHash: 'd'.repeat(64), evidenceHash: 'e'.repeat(64),
  }
  const dispatched = []
  const result = await evaluateCapacityWaitResumeAndDispatch({
    workRequest, currentRouteDecision: routeDecision, evaluate: () => ({ decision: 'resume' }),
    dispatch: value => { dispatched.push(value) },
  })
  assert.equal(result.dispatched, true)
  assert.deepEqual(dispatched, [{
    event_type: 'agent_work_requested', client_payload: { work_request: workRequest, route_decision: routeDecision },
  }])
})

for (const decision of ['stale', 'deferred']) {
  test(`${decision} resume evaluation is a read-only no-op`, async () => {
    let calls = 0
    const result = await evaluateCapacityWaitResumeAndDispatch({
      workRequest: {}, currentRouteDecision: {}, evaluate: () => ({ decision }), dispatch: () => { calls += 1 },
    })
    assert.equal(result.dispatched, false)
    assert.equal(calls, 0)
  })
}

test('only the landing schedule opts into self-hosted capacity observation', async () => {
  const dispatch = await readFile(new URL('../.github/workflows/dispatch-backlog.yml', import.meta.url), 'utf8')
  const landing = await readFile(new URL('../templates/target/.github/workflows/agent-landing-reconcile.yml', import.meta.url), 'utf8')
  const issues = await readFile(new URL('../templates/target/.github/workflows/agent-issues.yml', import.meta.url), 'utf8')
  assert.match(dispatch, /capacity_resume:[\s\S]*default: false/)
  assert.match(dispatch, /if: inputs\.capacity_resume[\s\S]*runs-on: \[self-hosted, agent-change\]/)
  assert.match(landing, /dispatch-backlog\.yml@[\s\S]*capacity_resume: true/)
  assert.doesNotMatch(issues, /capacity_resume: true/)
})
