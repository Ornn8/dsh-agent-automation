import assert from 'node:assert/strict'
import test from 'node:test'

import {
  MAINTENANCE_SCHEDULE_INTERVAL_MS,
  MAXIMUM_MAINTENANCE_AGE_MS,
  isMaintenanceRunFresh,
} from '../src/runner-watchdog-policy.mjs'

const now = Date.parse('2026-08-23T07:04:34Z')

test('maintenance readiness remains fresh across a three-interval schedule gap', () => {
  const lastSuccessfulRun = '2026-08-23T06:15:43Z'

  assert.equal(now - Date.parse(lastSuccessfulRun), 48 * 60 * 1000 + 51 * 1000)
  assert.equal(isMaintenanceRunFresh(lastSuccessfulRun, now), true)
})

test('maintenance readiness expires after four schedule intervals', () => {
  const lastSuccessfulRun = '2026-08-23T06:04:33Z'

  assert.equal(isMaintenanceRunFresh(lastSuccessfulRun, now), false)
})

test('maintenance readiness window is derived from four fifteen-minute intervals', () => {
  assert.equal(MAINTENANCE_SCHEDULE_INTERVAL_MS, 15 * 60 * 1000)
  assert.equal(MAXIMUM_MAINTENANCE_AGE_MS, 4 * MAINTENANCE_SCHEDULE_INTERVAL_MS)
})
