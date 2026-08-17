// @ts-check

import { isAbsolute, join, relative, resolve } from 'node:path'

const REVIEW_REPLICA_PATTERN = /^(?:target-[A-Za-z0-9_.-]+-review|organization-review)(?:-r[2-8])?$/

/** @param {string} left @param {string} right */
function samePath(left, right) {
  return process.platform === 'win32'
    ? left.localeCompare(right, undefined, { sensitivity: 'accent' }) === 0
    : left === right
}

/** Derive the only workspace and lease paths owned by one review runner replica. */
/** @param {string} stateRoot @param {string} replicaId */
export function reviewWorkspacePaths(stateRoot, replicaId) {
  if (typeof stateRoot !== 'string' || !isAbsolute(stateRoot)) {
    throw new Error('Review workspace stateRoot must be absolute')
  }
  if (typeof replicaId !== 'string' || !REVIEW_REPLICA_PATTERN.test(replicaId)) {
    throw new Error('Review workspace requires an exact review replica id')
  }
  const root = resolve(stateRoot)
  const directory = resolve(root, 'workspaces', replicaId)
  const leasePath = resolve(root, 'workspace-leases', `${replicaId}.json`)
  for (const [path, name] of [[directory, 'directory'], [leasePath, 'lease']]) {
    const relation = relative(root, path)
    if (!relation || relation.startsWith('..') || isAbsolute(relation)) {
      throw new Error(`Review workspace ${name} must be inside stateRoot`)
    }
  }
  return { slotId: replicaId, directory, leasePath }
}

/** Resolve a slot only when the install manifest owns the exact review runner. */
/**
 * @param {{manifest: {schemaVersion?: number, stateRoot?: string, instances?: Array<{id?: string, role?: string, taskEnabled?: boolean}>}, stateRoot: string, replicaId: string}} input
 */
export function registeredReviewWorkspace({ manifest, stateRoot, replicaId }) {
  if (manifest?.schemaVersion !== 1 || !Array.isArray(manifest.instances)) {
    throw new Error('Install manifest is missing or invalid')
  }
  if (typeof manifest.stateRoot !== 'string'
    || !samePath(resolve(manifest.stateRoot), resolve(stateRoot))) {
    throw new Error('Install manifest stateRoot does not match the runner configuration')
  }
  const matches = manifest.instances.filter(instance => instance?.id === replicaId
    && instance.role === 'review' && instance.taskEnabled === true)
  if (matches.length !== 1) {
    throw new Error(`${replicaId} is not one enabled registered review runner`)
  }
  return reviewWorkspacePaths(stateRoot, replicaId)
}

/** Decide whether an existing local lease must remain held or can be reclaimed. */
/**
 * @param {{lease: {expiresAt?: string}, now?: number, pidAlive: boolean, workRequestTerminal?: boolean, workRequestSuperseded?: boolean}} input
 */
export function reviewWorkspaceLeaseDecision({
  lease,
  now = Date.now(),
  pidAlive,
  workRequestTerminal = false,
  workRequestSuperseded = false,
}) {
  const expiresAt = typeof lease?.expiresAt === 'string' ? Date.parse(lease.expiresAt) : Number.NaN
  if (!Number.isFinite(expiresAt)) throw new Error('Review workspace lease expiry is invalid')
  if (!pidAlive || now > expiresAt || workRequestTerminal || workRequestSuperseded) return 'reclaim'
  return 'held'
}
