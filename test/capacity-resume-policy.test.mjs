import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { createIssueCapacityWaitProjection } from '../src/capacity-wait-projection.mjs'
import { createCapacityRecord } from '../src/capacity-registry.mjs'
import { resolveMachineConfig } from '../src/machine-config.mjs'
import { createStageWorkRequest } from '../src/work-request.mjs'
import { parseWorkflowDefinition, workflowDefinitionHash } from '../src/workflow-definition.mjs'
import { createWorkerRouteDecision } from '../src/worker-routing.mjs'
import { evaluateCapacityWaitResume } from '../src/capacity-resume-policy.mjs'

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
  const record = workerId => createCapacityRecord({
    capacityGroup: workerId,
    scope: 'worker',
    sourceWorker: workerId,
    capacityIdentity: { worker: workerId },
    configurationHash: 'f'.repeat(64),
    credentialGeneration: '1',
    now,
  })
  return {
    definition,
    definitionHash,
    workRequest,
    projection,
    currentSubject: { type: 'issue', number: 17, stateVersion, revision: { base, head: base } },
    previousMachineConfig,
    currentMachineConfig,
    previousCapacity: {
      generationHash: '1'.repeat(64),
      records: { change: { ...record('change'), state: 'cooldown', reason: 'quota-exhausted', retryAtUtc: new Date(now + 60_000).toISOString(), generation: 1 } },
    },
    currentCapacity: {
      generationHash: '2'.repeat(64),
      records: { change: { ...record('change'), state: 'cooldown', reason: 'quota-exhausted', retryAtUtc: new Date(now + 60_000).toISOString(), generation: 1 }, change2: record('change2') },
    },
    now,
  }
}

test('a newly added matching Worker makes an existing Issue wait resume-eligible', async () => {
  const input = await fixture()
  const before = evaluateCapacityWaitResume({
    projection: input.projection,
    workRequest: input.workRequest,
    profile: { definition: input.definition, definitionHash: input.definitionHash },
    currentSubject: input.currentSubject,
    currentRouteDecision: input.projection.routeDecision,
    machineConfig: input.previousMachineConfig,
    capacitySnapshot: input.previousCapacity,
    now: input.now,
  })
  const after = evaluateCapacityWaitResume({
    projection: input.projection,
    workRequest: input.workRequest,
    profile: { definition: input.definition, definitionHash: input.definitionHash },
    currentSubject: input.currentSubject,
    currentRouteDecision: input.projection.routeDecision,
    machineConfig: input.currentMachineConfig,
    capacitySnapshot: input.currentCapacity,
    now: input.now,
  })

  assert.equal(before.decision, 'deferred')
  assert.equal(after.decision, 'resume')
  assert.deepEqual(after.availableCandidates, ['change2'])
  assert.equal(after.capacityResumeRequestId, before.capacityResumeRequestId)
  assert.equal(after.capacityResumeRequestId, evaluateCapacityWaitResume({
    projection: input.projection,
    workRequest: input.workRequest,
    profile: { definition: input.definition, definitionHash: input.definitionHash },
    currentSubject: input.currentSubject,
    currentRouteDecision: input.projection.routeDecision,
    machineConfig: input.currentMachineConfig,
    capacitySnapshot: input.currentCapacity,
    now: input.now,
  }).capacityResumeRequestId)
})

test('stale Issue revision and changed route decision cannot resume a wait', async () => {
  const input = await fixture()
  const evaluate = overrides => evaluateCapacityWaitResume({
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

  assert.equal(evaluate({
    currentSubject: { ...input.currentSubject, revision: { base: 'c'.repeat(40), head: base } },
  }).decision, 'stale')
  assert.equal(evaluate({
    currentRouteDecision: { ...input.projection.routeDecision, taskClass: 'other' },
  }).decision, 'stale')
  assert.equal(evaluate({
    profile: { definition: input.definition, definitionHash: 'f'.repeat(64) },
  }).decision, 'stale')
})

test('identical inputs produce one bounded decision and missing capacity is stale', async () => {
  const input = await fixture()
  const options = {
    projection: input.projection,
    workRequest: input.workRequest,
    profile: { definition: input.definition, definitionHash: input.definitionHash },
    currentSubject: input.currentSubject,
    currentRouteDecision: input.projection.routeDecision,
    machineConfig: input.currentMachineConfig,
    capacitySnapshot: input.currentCapacity,
    now: input.now,
  }
  const first = evaluateCapacityWaitResume(options)
  const second = evaluateCapacityWaitResume(structuredClone(options))
  assert.deepEqual(second, first)
  assert.deepEqual(Object.keys(first).sort(), [
    'availableCandidates', 'capacityGenerationHash', 'capacityResumeRequestId', 'currentCandidates',
    'decision', 'reason', 'version',
  ])
  assert.equal(evaluateCapacityWaitResume({ ...options, capacitySnapshot: undefined }).decision, 'stale')
})
