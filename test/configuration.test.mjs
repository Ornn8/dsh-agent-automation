import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { resolveMachineConfig, resolveWorkerCandidates, roleWorkerIds } from '../src/machine-config.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const readJson = async relative => JSON.parse(await readFile(new URL(`../${relative}`, import.meta.url), 'utf8'))

test('minimal configuration stays short and resolves the complete role topology', async () => {
  const [text, defaults, input] = await Promise.all([
    readFile(new URL('../config.minimal.json', import.meta.url), 'utf8'),
    readJson('ops/config.defaults.json'),
    readJson('config.minimal.json'),
  ])

  assert.ok(text.trimEnd().split(/\r?\n/).length <= 40)
  const config = resolveMachineConfig({ defaults, input, configurationPath: `${root}/config.minimal.json` })
  assert.deepEqual(roleWorkerIds(config, 'change'), ['change'])
  assert.deepEqual(roleWorkerIds(config, 'review'), ['review'])
  assert.deepEqual(roleWorkerIds(config, 'maintenance'), ['maintenance'])
  assert.equal(config.workers.change.mode, 'change')
  assert.equal(config.workers.change.capacityGroup, 'change')
  assert.deepEqual(config.workers.change.routingTags, [])
  assert.equal(config.workers.review.capabilities.hardReadOnlyReview, true)
  assert.equal(config.workers.maintenance.githubLogin, input.github.login)
  assert.match(config.configurationHash, /^[a-f0-9]{64}$/)
})

test('legacy Worker ids and ordinal tags resolve identically without a routing migration', async () => {
  const [defaults, input, fixture] = await Promise.all([
    readJson('ops/config.defaults.json'), readJson('config.minimal.json'), readJson('test/fixtures/worker-routing.json'),
  ])
  const pooled = structuredClone(input)
  for (const workerId of fixture.workerIds) {
    pooled.workers[workerId] = { ...pooled.workers.review, routingTags: fixture.routingTags[workerId] }
  }
  delete pooled.workers.review
  pooled.operations.roles.review.workers = fixture.workerIds

  const legacy = resolveMachineConfig({ defaults, input: pooled, configurationPath: `${root}/config.minimal.json` })
  assert.deepEqual(roleWorkerIds(legacy, 'review'), fixture.workerIds)
  assert.deepEqual(resolveWorkerCandidates({ config: legacy, role: 'review' }), [fixture.workerIds[0]])
  for (const workerId of fixture.workerIds) {
    assert.equal(legacy.workers[workerId].capacityGroup, fixture.expected.capacityGroups[workerId])
  }

  pooled.operations.routing = { review: { routes: fixture.routes } }
  const routed = resolveMachineConfig({ defaults, input: pooled, configurationPath: `${root}/config.minimal.json` })
  assert.deepEqual(resolveWorkerCandidates({ config: routed, role: 'review' }), fixture.expected.default)
  assert.deepEqual(
    resolveWorkerCandidates({ config: routed, role: 'review', routeDecision: { route: 'frontend' } }),
    fixture.expected.frontend,
  )
  assert.deepEqual(
    resolveWorkerCandidates({ config: routed, role: 'review', routeDecision: { route: 'caseExact' } }),
    fixture.expected.caseExact,
  )
  assert.notEqual(fixture.workerIds[0], fixture.expected.default[0])
})

test('route compilation memoizes the maximum bounded shared-subgraph DAG', async () => {
  const [defaults, input] = await Promise.all([
    readJson('ops/config.defaults.json'), readJson('config.minimal.json'),
  ])
  const routes = { default: { selectors: [{ worker: 'change' }] } }
  let previous = 'default'
  for (let index = 1; index < 32; index += 1) {
    const routeName = `route-${index}`
    routes[routeName] = { selectors: Array.from({ length: 16 }, () => ({ route: previous })) }
    previous = routeName
  }
  input.operations.routing = { change: { routes } }

  const config = resolveMachineConfig({ defaults, input, configurationPath: `${root}/config.minimal.json` })
  assert.deepEqual(resolveWorkerCandidates({ config, role: 'change', routeDecision: { route: previous } }), ['change'])
})

test('routing configuration rejects route cycles and empty non-default routes', async () => {
  const [defaults, input] = await Promise.all([
    readJson('ops/config.defaults.json'), readJson('config.minimal.json'),
  ])
  const cyclic = structuredClone(input)
  cyclic.operations.routing = {
    change: { routes: { default: { selectors: [{ route: 'loop' }] }, loop: { selectors: [{ route: 'default' }] } } },
  }
  assert.throws(
    () => resolveMachineConfig({ defaults, input: cyclic, configurationPath: `${root}/config.minimal.json` }),
    /contains a cycle/,
  )

  const empty = structuredClone(input)
  empty.operations.routing = {
    change: { routes: { default: { selectors: [{ worker: 'change' }] }, frontend: { selectors: [{ allTags: ['missing'] }] } } },
  }
  assert.throws(
    () => resolveMachineConfig({ defaults, input: empty, configurationPath: `${root}/config.minimal.json` }),
    /resolves to no admitted Worker/,
  )
})

test('configuration identity excludes credential generation but includes operational changes', async () => {
  const [defaults, input] = await Promise.all([
    readJson('ops/config.defaults.json'), readJson('config.minimal.json'),
  ])
  const resolve = value => resolveMachineConfig({ defaults, input: value, configurationPath: `${root}/config.minimal.json` })
  const original = resolve(input)
  const credentialBump = structuredClone(input)
  credentialBump.credentialGeneration = '2'
  assert.equal(resolve(credentialBump).configurationHash, original.configurationHash)
  const topologyChange = structuredClone(input)
  topologyChange.operations.roles.change.replicas = 2
  assert.notEqual(resolve(topologyChange).configurationHash, original.configurationHash)
})

test('removed entry points and cross-domain Worker reuse fail before an Adapter starts', async () => {
  const [defaults, input] = await Promise.all([
    readJson('ops/config.defaults.json'), readJson('config.minimal.json'),
  ])
  const resolve = value => resolveMachineConfig({ defaults, input: value, configurationPath: `${root}/config.minimal.json` })
  for (const field of ['schemaVersion', 'configRevision', 'credentialRevision', 'repositories', 'maintenanceWorkers', 'maintenanceReviewWorker']) {
    const legacy = structuredClone(input)
    legacy[field] = field.endsWith('Workers') ? [] : 'legacy'
    assert.throws(() => resolve(legacy), /was removed/)
  }
  const workerProject = structuredClone(input)
  workerProject.workers.review.projectCwd = 'F:\\one-project-for-every-repository'
  assert.throws(() => resolve(workerProject), /projectCwd was removed/)
  const reused = structuredClone(input)
  reused.operations.roles.maintenance.workers = ['review']
  delete reused.workers.maintenance
  assert.throws(() => resolve(reused), /cannot serve both review and maintenance trust domains/)
})

test('repository mappings cannot select the Controller itself, regardless of case', async () => {
  const [defaults, input] = await Promise.all([
    readJson('ops/config.defaults.json'), readJson('config.minimal.json'),
  ])
  const selfTarget = structuredClone(input)
  selfTarget.operations.controller.repository = 'Ornn8/dsh-agent-automation'
  selfTarget.operations.repositoryMappings[0].repository = 'ornn8/DSH-AGENT-AUTOMATION'

  assert.throws(
    () => resolveMachineConfig({ defaults, input: selfTarget, configurationPath: `${root}/config.minimal.json` }),
    /repositoryMappings.*must not target the controller repository/i,
  )
})

test('repository mappings continue to accept an ordinary product target', async () => {
  const [defaults, input] = await Promise.all([
    readJson('ops/config.defaults.json'), readJson('config.minimal.json'),
  ])
  const target = structuredClone(input)
  target.operations.controller.repository = 'Ornn8/dsh-agent-automation'
  target.operations.repositoryMappings[0].repository = 'Ornn8/shanyin-tea-commerce'

  assert.doesNotThrow(() => resolveMachineConfig({
    defaults, input: target, configurationPath: `${root}/config.minimal.json`,
  }))
})

test('every public schema property is visible in the minimal file or configuration reference', async () => {
  const [schema, minimal, defaults, reference] = await Promise.all([
    readJson('ops/config.schema.json'),
    readFile(new URL('../config.minimal.json', import.meta.url), 'utf8'),
    readFile(new URL('../ops/config.defaults.json', import.meta.url), 'utf8'),
    readFile(new URL('../docs/configuration-reference.md', import.meta.url), 'utf8'),
  ])
  const propertyNames = new Set()
  const visit = value => {
    if (!value || typeof value !== 'object') return
    if (value.properties) for (const name of Object.keys(value.properties)) propertyNames.add(name)
    for (const item of Object.values(value)) visit(item)
  }
  visit(schema)
  const visible = `${minimal}\n${defaults}\n${reference}`
  const missing = [...propertyNames].filter(name => !visible.includes(`\`${name}\``) && !visible.includes(`"${name}"`))
  assert.deepEqual(missing, [])
})
