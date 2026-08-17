import assert from 'node:assert/strict'
import { join } from 'node:path'
import test from 'node:test'
import {
  registeredReviewWorkspace,
  reviewWorkspaceLeaseDecision,
  reviewWorkspacePaths,
} from '../src/review-workspace-policy.mjs'

const stateRoot = process.platform === 'win32' ? 'F:\\automation-state' : '/automation-state'
const replicaId = 'target-owner-repository-a1b2c3d4e5f6-review'

test('review workspace paths are derived only from an exact review replica id', () => {
  assert.deepEqual(reviewWorkspacePaths(stateRoot, replicaId), {
    slotId: replicaId,
    directory: join(stateRoot, 'workspaces', replicaId),
    leasePath: join(stateRoot, 'workspace-leases', `${replicaId}.json`),
  })
  assert.throws(() => reviewWorkspacePaths(stateRoot, '../review'), /review replica id/)
  assert.throws(() => reviewWorkspacePaths(stateRoot, 'target-owner-repository-change'), /review replica id/)
})

test('only a manifest-registered review instance authorizes its derived slot', () => {
  const manifest = {
    schemaVersion: 1,
    stateRoot,
    instances: [{ id: replicaId, role: 'review', taskEnabled: true }],
  }
  assert.equal(registeredReviewWorkspace({ manifest, stateRoot, replicaId }).slotId, replicaId)
  assert.throws(() => registeredReviewWorkspace({
    manifest: { ...manifest, instances: [{ id: replicaId, role: 'change', taskEnabled: true }] },
    stateRoot,
    replicaId,
  }), /registered review runner/)
  assert.throws(() => registeredReviewWorkspace({
    manifest: { ...manifest, stateRoot: join(stateRoot, 'other') },
    stateRoot,
    replicaId,
  }), /stateRoot/)
})

test('lease decisions hold live work and reclaim bounded stale work', () => {
  const now = Date.parse('2026-08-17T00:00:00Z')
  const lease = {
    expiresAt: '2026-08-17T01:00:00Z',
  }
  assert.equal(reviewWorkspaceLeaseDecision({ lease, now, pidAlive: true }), 'held')
  assert.equal(reviewWorkspaceLeaseDecision({ lease, now, pidAlive: false }), 'reclaim')
  assert.equal(reviewWorkspaceLeaseDecision({ lease, now: now + 3_600_001, pidAlive: true }), 'reclaim')
  assert.equal(reviewWorkspaceLeaseDecision({ lease, now, pidAlive: true, workRequestTerminal: true }), 'reclaim')
  assert.equal(reviewWorkspaceLeaseDecision({ lease, now, pidAlive: true, workRequestSuperseded: true }), 'reclaim')
})
