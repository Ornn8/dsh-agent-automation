import { appendCapacityAttempt, createCapacityAttempt, withCapacityRegistryLock, capacityRegistryPaths } from '../../src/capacity-registry-store.mjs'
import { readFile, writeFile } from 'node:fs/promises'

const [, , mode, stateRoot, id] = process.argv
const hash = 'a'.repeat(64)
const now = Date.parse('2026-08-21T00:00:00.000Z')

if (!stateRoot || !id) throw new Error('usage: append|lock <stateRoot> <id>')

if (mode === 'lock') {
  const statePath = `${capacityRegistryPaths(stateRoot).directory}/lock-observations.json`
  await withCapacityRegistryLock(stateRoot, async () => {
    let state
    try { state = JSON.parse(await readFile(statePath, 'utf8')) } catch (error) {
      if (error?.code !== 'ENOENT') throw error
      state = { active: 0, maxActive: 0, calls: {} }
    }
    state.active += 1
    state.maxActive = Math.max(state.maxActive, state.active)
    state.calls[id] = (state.calls[id] ?? 0) + 1
    await writeFile(statePath, `${JSON.stringify(state)}\n`, 'utf8')
    await new Promise(resolve => setTimeout(resolve, 25))
    state.active -= 1
    await writeFile(statePath, `${JSON.stringify(state)}\n`, 'utf8')
  }, { waitMs: 60_000, leaseMs: 60_000 })
  process.stdout.write('locked\n')
  process.exit(0)
}

if (mode === 'crash') {
  await withCapacityRegistryLock(stateRoot, async () => {
    process.stdout.write('crashed-in-critical-section\n')
    process.exit(17)
  }, { waitMs: 5_000, leaseMs: 100 })
}

if (mode === 'expire') {
  const statePath = `${capacityRegistryPaths(stateRoot).directory}/expire-observation.json`
  await withCapacityRegistryLock(stateRoot, async () => {
    let state
    try { state = JSON.parse(await readFile(statePath, 'utf8')) } catch (error) {
      if (error?.code !== 'ENOENT') throw error
      state = { calls: 0 }
    }
    state.calls += 1
    await writeFile(statePath, `${JSON.stringify(state)}\n`, 'utf8')
    await new Promise(resolve => setTimeout(resolve, 250))
  }, { waitMs: 5_000, leaseMs: 100 })
}

if (mode !== 'append') throw new Error('usage: append|lock|crash|expire <stateRoot> <id>')

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
