import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { parseMaintenanceProfile } from '../src/maintenance-profile.mjs'

const path = new URL('../.github/agent-automation/profiles/controller-maintenance.json', import.meta.url)

test('the installed Controller maintenance Profile preserves mandatory safety limits', async () => {
  const profile = parseMaintenanceProfile(JSON.parse(await readFile(path, 'utf8')))
  assert.equal(profile.profileId, 'controller-maintenance')
  assert.equal(profile.deterministic.limit, 3)
  assert.equal(profile.repair.maxPullRequestsPerEpoch, 1)
  assert.equal(profile.repair.failoverBackoffSeconds, 300)
  assert.equal(profile.checks.waitMinutes, 180)
  assert.deepEqual(profile.promotion, { mode: 'fault-bound', limitPerEpoch: 1 })
  assert.deepEqual(profile.limits, {
    maxEpochsPer24Hours: 3,
    maintenanceWorkerAttemptsPerEpoch: 1,
    concurrency: 1,
  })
  assert.equal(profile.verification.healthySamples, 3)
})

test('the Profile cannot disable review, broaden paths, or raise circuit limits', async () => {
  const source = JSON.parse(await readFile(path, 'utf8'))
  assert.throws(() => parseMaintenanceProfile({ ...source, review: { ...source.review, required: false } }), /cannot disable/)
  assert.throws(() => parseMaintenanceProfile({ ...source, repair: { ...source.repair, allowedPaths: ['../product/**'] } }), /safe repository-relative/)
  assert.throws(() => parseMaintenanceProfile({ ...source, limits: { ...source.limits, maxEpochsPer24Hours: 4 } }), /from 1 to 3/)
})
