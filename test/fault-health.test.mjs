import test from 'node:test'
import assert from 'node:assert/strict'
import { observeFaultHealth, parseFaultHealthState } from '../src/fault-health.mjs'

const faultId = 'a'.repeat(64)

test('stable recovery changes health generation only after three consecutive healthy samples', () => {
  let state = observeFaultHealth(undefined, { faultId, healthy: true })
  assert.equal(state.generation, 0)
  state = observeFaultHealth(state, { faultId, healthy: false })
  assert.equal(state.consecutiveHealthy, 0)
  for (let sample = 1; sample <= 3; sample += 1) {
    state = observeFaultHealth(state, { faultId, healthy: true })
    assert.equal(state.generation, sample === 3 ? 1 : 0)
  }
  state = observeFaultHealth(state, { faultId, healthy: true })
  assert.equal(state.generation, 1)
})

test('fault health state rejects unrelated or mutable records', () => {
  assert.throws(() => parseFaultHealthState({
    faultId: 'b'.repeat(64), status: 'healthy', consecutiveHealthy: 3, generation: 1,
  }, faultId), /invalid/)
})
