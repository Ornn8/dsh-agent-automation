import test from 'node:test'
import assert from 'node:assert/strict'
import { createFaultRecord } from '../src/fault-record.mjs'
import { attestedFaultRecordBody, trustedFaultRecords } from '../src/fault-attestation.mjs'

const record = createFaultRecord({
  repository: 'owner/controller', component: 'runner', operation: 'start', failureClass: 'host', errorCode: 'offline',
  rootRequestIds: ['issue-1'], now: '2026-08-16T00:00:00Z',
  stateVersion: {
    controllerSha: '1'.repeat(40), runtimeSnapshotHash: '2'.repeat(64), configRevision: 'config-1',
    credentialRevision: 'credential-1', healthGeneration: 0, failureSignature: 'offline',
  },
})

test('FaultRecord comments require a completed exact Controller maintenance run', async () => {
  const body = attestedFaultRecordBody(record, { repository: 'owner/controller', controllerSha: '1'.repeat(40), runId: 42 })
  const comments = [{ id: 7, user: { login: 'github-actions[bot]' }, author_association: 'NONE', body }]
  const valid = await trustedFaultRecords({
    comments, faultId: record.faultId, controllerRepository: 'owner/controller',
    loadRun: async () => ({
      repository: { full_name: 'owner/controller' }, path: '.github/workflows/controller-maintenance.yml',
      head_sha: '1'.repeat(40), status: 'completed', conclusion: 'success', event: 'schedule',
    }),
  })
  assert.equal(valid.length, 1)
  const invalid = await trustedFaultRecords({
    comments, faultId: record.faultId, controllerRepository: 'owner/controller',
    loadRun: async () => ({ repository: { full_name: 'owner/controller' }, path: '.github/workflows/controller-maintenance.yml', head_sha: '1'.repeat(40), status: 'completed', conclusion: 'failure', event: 'schedule' }),
  })
  assert.equal(invalid.length, 0)
})
