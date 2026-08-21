import { loadOrCreateLocalWorkerRoutingExecution } from '../../src/worker-routing.mjs'

const [, , stateRoot] = process.argv
if (!stateRoot) throw new Error('usage: worker-routing-process <stateRoot>')

const result = await loadOrCreateLocalWorkerRoutingExecution({
  stateRoot,
  workRequest: {
    version: 2,
    requestId: 'worker-routing-process-work',
    role: 'change',
    profileId: 'example-profile',
    workflowId: 'default',
    stageId: 'change',
    definitionHash: 'a'.repeat(64),
    repository: 'owner/repository',
    subject: { type: 'issue', number: 121 },
    revision: { base: 'b'.repeat(40), head: 'b'.repeat(40) },
    coordinationKey: 'owner/repository:example-profile:default',
  },
  subjectStateVersion: 'c'.repeat(64),
  trustedTaskSnapshot: { workflowStage: 'change' },
  routingPolicy: { routes: { default: {} } },
})

process.stdout.write(`${JSON.stringify(result)}\n`)
