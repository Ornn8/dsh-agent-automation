import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import {
  acquireReviewWorkspace,
  prepareReviewWorkspace,
  releaseReviewWorkspace,
} from '../src/review-workspace.mjs'
import { reviewWorkspacePaths } from '../src/review-workspace-policy.mjs'
import { run } from '../src/common.mjs'

const replicaId = 'target-owner-repository-a1b2c3d4e5f6-review'
const baseSha = 'a'.repeat(40)
const headSha = 'b'.repeat(40)

async function fixture() {
  const stateRoot = await mkdtemp(join(tmpdir(), 'review-workspace-'))
  const paths = reviewWorkspacePaths(stateRoot, replicaId)
  await mkdir(paths.directory, { recursive: true })
  await mkdir(join(stateRoot, 'workspace-leases'), { recursive: true })
  const manifest = {
    schemaVersion: 1,
    stateRoot,
    instances: [{ id: replicaId, role: 'review', taskEnabled: true }],
  }
  await writeFile(join(stateRoot, 'install-manifest.json'), `${JSON.stringify(manifest)}\n`)
  return { stateRoot, paths, manifest }
}

test('one review replica cannot grant its slot to two live work requests', async () => {
  const root = await fixture()
  try {
    const first = await acquireReviewWorkspace({
      stateRoot: root.stateRoot,
      replicaId,
      workRequestId: 'review-pr-4-a-b',
      repository: 'owner/repository',
      baseSha,
      headSha,
      pid: process.pid,
      now: Date.parse('2026-08-17T00:00:00Z'),
      timeoutMs: 60_000,
    })
    assert.equal(first.directory, root.paths.directory)
    assert.equal(await acquireReviewWorkspace({
      stateRoot: root.stateRoot,
      replicaId,
      workRequestId: 'review-pr-5-a-b',
      repository: 'owner/repository',
      baseSha,
      headSha,
      pid: process.pid,
      now: Date.parse('2026-08-17T00:00:01Z'),
      timeoutMs: 60_000,
    }), null)
    await releaseReviewWorkspace(first)
    await assert.rejects(readFile(root.paths.leasePath, 'utf8'), error => error.code === 'ENOENT')
  } finally {
    await rm(root.stateRoot, { recursive: true, force: true })
  }
})

test('a dead lease is reclaimed without changing the registered slot', async () => {
  const root = await fixture()
  try {
    await writeFile(root.paths.leasePath, `${JSON.stringify({
      slotId: replicaId,
      pid: 99,
      workRequestId: 'stale',
      repository: 'owner/repository',
      baseSha,
      headSha,
      acquiredAt: '2026-08-17T00:00:00.000Z',
      expiresAt: '2026-08-17T01:00:00.000Z',
    })}\n`)
    const acquired = await acquireReviewWorkspace({
      stateRoot: root.stateRoot,
      replicaId,
      workRequestId: 'replacement',
      repository: 'owner/repository',
      baseSha,
      headSha,
      pid: process.pid,
      now: Date.parse('2026-08-17T00:01:00Z'),
      timeoutMs: 60_000,
      processAlive: () => false,
    })
    assert.equal(acquired.lease.workRequestId, 'replacement')
    await releaseReviewWorkspace(acquired)
  } finally {
    await rm(root.stateRoot, { recursive: true, force: true })
  }
})

test('preparation cleans only the registered slot and verifies the exact pair', async () => {
  const root = await fixture()
  const source = await mkdtemp(join(tmpdir(), 'review-workspace-source-'))
  try {
    await run('git', ['init', source])
    await run('git', ['-C', source, 'config', 'user.name', 'Review Workspace Test'])
    await run('git', ['-C', source, 'config', 'user.email', 'review-workspace@example.invalid'])
    await writeFile(join(source, 'base.txt'), 'base\n')
    await run('git', ['-C', source, 'add', 'base.txt'])
    await run('git', ['-C', source, 'commit', '-m', 'base'])
    const base = (await run('git', ['-C', source, 'rev-parse', 'HEAD'])).stdout.trim()
    await writeFile(join(source, 'head.txt'), 'head\n')
    await run('git', ['-C', source, 'add', 'head.txt'])
    await run('git', ['-C', source, 'commit', '-m', 'head'])
    const head = (await run('git', ['-C', source, 'rev-parse', 'HEAD'])).stdout.trim()
    await writeFile(join(root.paths.directory, 'stale.tmp'), 'remove me')

    const prepared = await prepareReviewWorkspace({
      stateRoot: root.stateRoot,
      replicaId,
      repository: 'owner/repository',
      remoteUrl: source,
      baseSha: base,
      headSha: head,
      gitExecutable: 'git',
      environment: process.env,
    })

    assert.equal(prepared.head, head)
    assert.equal(prepared.mergeBase, base)
    await assert.rejects(readFile(join(root.paths.directory, 'stale.tmp'), 'utf8'), error => error.code === 'ENOENT')
    assert.equal((await run('git', ['-C', root.paths.directory, 'rev-parse', 'HEAD'])).stdout.trim(), head)
  } finally {
    await rm(root.stateRoot, { recursive: true, force: true })
    await rm(source, { recursive: true, force: true })
  }
})
