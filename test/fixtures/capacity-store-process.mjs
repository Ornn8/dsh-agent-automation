import { appendCapacityAttempt, createCapacityAttempt } from '../../src/capacity-registry-store.mjs'

const [, , mode, stateRoot, id] = process.argv
const hash = 'a'.repeat(64)
const now = Date.parse('2026-08-21T00:00:00.000Z')

if (mode !== 'append' || !stateRoot || !id) throw new Error('usage: append <stateRoot> <id>')

await appendCapacityAttempt(stateRoot, createCapacityAttempt({
  attemptId: `attempt-${id}`,
  workRequestId: `work-request-${id}`,
  routePolicyHash: hash,
  taskClass: 'general',
  workerId: 'worker-1',
  capacityGroup: 'provider-account-1',
  capacityGeneration: 1,
  startState: 'available',
  startedAt: now,
  endedAt: now + 1000,
  result: { outcome: 'completed' },
}))
process.stdout.write('done\n')
