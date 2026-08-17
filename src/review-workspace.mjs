// @ts-check

import { lstat, open, readFile, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { parseJson, run } from './common.mjs'
import {
  registeredReviewWorkspace,
  reviewWorkspaceLeaseDecision,
} from './review-workspace-policy.mjs'

/** @typedef {{slotId: string, pid: number, workRequestId: string, repository: string, baseSha: string, headSha: string, acquiredAt: string, expiresAt: string}} ReviewWorkspaceLease */
/** @typedef {{slotId: string, directory: string, leasePath: string}} ReviewWorkspace */
/** @typedef {ReviewWorkspace & {lease: ReviewWorkspaceLease}} AcquiredReviewWorkspace */

/** @param {unknown} value @param {string} name @returns {string} */
function requiredText(value, name) {
  if (typeof value !== 'string' || !value.trim() || /[\r\n]/.test(value)) {
    throw new Error(`${name} must be non-empty one-line text`)
  }
  return value
}

/** @param {unknown} value @param {string} name @returns {string} */
function requiredSha(value, name) {
  if (typeof value !== 'string' || !/^[0-9a-f]{40}$/i.test(value)) {
    throw new Error(`${name} must be a full commit SHA`)
  }
  return value.toLowerCase()
}

/** @param {string} text @returns {ReviewWorkspaceLease} */
function parseLease(text) {
  /** @type {Record<string, unknown>} */
  const lease = parseJson(text, 'review workspace lease')
  const slotId = requiredText(lease.slotId, 'review workspace lease slotId')
  const workRequestId = requiredText(lease.workRequestId, 'review workspace lease workRequestId')
  const repository = requiredText(lease.repository, 'review workspace lease repository')
  const baseSha = requiredSha(lease.baseSha, 'review workspace lease baseSha')
  const headSha = requiredSha(lease.headSha, 'review workspace lease headSha')
  const acquiredAt = requiredText(lease.acquiredAt, 'review workspace lease acquiredAt')
  const expiresAt = requiredText(lease.expiresAt, 'review workspace lease expiresAt')
  const pid = lease.pid
  if (!Number.isSafeInteger(pid) || /** @type {number} */ (pid) < 1) {
    throw new Error('review workspace lease pid must be a positive integer')
  }
  if (!Number.isFinite(Date.parse(acquiredAt)) || !Number.isFinite(Date.parse(expiresAt))) {
    throw new Error('review workspace lease timestamps are invalid')
  }
  return { slotId, pid: /** @type {number} */ (pid), workRequestId, repository, baseSha, headSha, acquiredAt, expiresAt }
}

/** @param {number} pid @returns {boolean} */
function defaultProcessAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** @param {unknown} error @param {string} code @returns {boolean} */
function hasErrorCode(error, code) {
  return typeof error === 'object' && error !== null && 'code' in error
    && /** @type {{code?: unknown}} */ (error).code === code
}

/** @param {string} stateRoot @param {string} replicaId @returns {Promise<ReviewWorkspace>} */
async function loadRegisteredWorkspace(stateRoot, replicaId) {
  const manifestPath = join(stateRoot, 'install-manifest.json')
  const manifest = parseJson(await readFile(manifestPath, 'utf8'), 'install manifest')
  const workspace = registeredReviewWorkspace({ manifest, stateRoot, replicaId })
  const directory = await lstat(workspace.directory)
  if (!directory.isDirectory() || directory.isSymbolicLink()) {
    throw new Error(`Registered review workspace is not one physical directory: ${workspace.directory}`)
  }
  const leaseRoot = await lstat(dirname(workspace.leasePath))
  if (!leaseRoot.isDirectory() || leaseRoot.isSymbolicLink()) {
    throw new Error(`Review workspace lease root is not one physical directory: ${dirname(workspace.leasePath)}`)
  }
  return workspace
}

/** Acquire one registered review replica slot without waiting in-process. */
/**
 * @param {{stateRoot: string, replicaId: string, workRequestId: string, repository: string, baseSha: string, headSha: string, pid?: number, now?: number, timeoutMs: number, processAlive?: (pid: number) => boolean}} input
 * @returns {Promise<AcquiredReviewWorkspace | null>}
 */
export async function acquireReviewWorkspace({
  stateRoot,
  replicaId,
  workRequestId,
  repository,
  baseSha,
  headSha,
  pid = process.pid,
  now = Date.now(),
  timeoutMs,
  processAlive = defaultProcessAlive,
}) {
  const workspace = await loadRegisteredWorkspace(stateRoot, replicaId)
  requiredText(workRequestId, 'review workRequestId')
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository || '')) {
    throw new Error('Review workspace repository must be owner/name')
  }
  const normalizedBase = requiredSha(baseSha, 'review workspace baseSha')
  const normalizedHead = requiredSha(headSha, 'review workspace headSha')
  if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('Review workspace pid must be a positive integer')
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error('Review workspace timeoutMs must be a positive integer')
  }
  const acquiredAt = new Date(now).toISOString()
  const lease = {
    slotId: workspace.slotId,
    pid,
    workRequestId,
    repository,
    baseSha: normalizedBase,
    headSha: normalizedHead,
    acquiredAt,
    expiresAt: new Date(now + timeoutMs).toISOString(),
  }

  for (let attempt = 0; attempt < 2; attempt += 1) {
    let handle
    try {
      handle = await open(workspace.leasePath, 'wx')
      await handle.writeFile(`${JSON.stringify(lease)}\n`, 'utf8')
      await handle.sync()
      return { ...workspace, lease }
    } catch (error) {
      if (!hasErrorCode(error, 'EEXIST')) throw error
      const existing = parseLease(await readFile(workspace.leasePath, 'utf8'))
      const decision = reviewWorkspaceLeaseDecision({
        lease: existing,
        now,
        pidAlive: processAlive(existing.pid),
      })
      if (decision === 'held') return null
      await unlink(workspace.leasePath)
    } finally {
      await handle?.close()
    }
  }
  throw new Error(`Review workspace lease could not be acquired after reclaim: ${workspace.slotId}`)
}

/** Release a lease only when the on-disk owner still matches this invocation. */
/** @param {AcquiredReviewWorkspace} workspace @returns {Promise<void>} */
export async function releaseReviewWorkspace(workspace) {
  let existing
  try {
    existing = parseLease(await readFile(workspace.leasePath, 'utf8'))
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) return
    throw error
  }
  if (existing.slotId !== workspace.lease.slotId
    || existing.pid !== workspace.lease.pid
    || existing.workRequestId !== workspace.lease.workRequestId) {
    throw new Error(`Review workspace lease owner changed before release: ${workspace.slotId}`)
  }
  await unlink(workspace.leasePath)
}

/** @param {NodeJS.ProcessEnv | undefined} environment @param {string} remoteUrl @returns {NodeJS.ProcessEnv} */
function gitFetchEnvironment(environment, remoteUrl) {
  if (!/^https:\/\/github\.com\//i.test(remoteUrl)) return { ...environment }
  const token = environment?.GITHUB_TOKEN?.trim()
  if (!token) throw new Error('Review workspace fetch requires the current Actions token')
  const authorization = Buffer.from(`x-access-token:${token}`).toString('base64')
  return {
    ...environment,
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${authorization}`,
    GIT_TERMINAL_PROMPT: '0',
  }
}

/** Reset one registered slot and materialize the exact detached review pair. */
/**
 * @param {{stateRoot: string, replicaId: string, repository: string, remoteUrl: string, baseSha: string, headSha: string, gitExecutable: string, environment?: NodeJS.ProcessEnv, runCommand?: typeof run}} input
 */
export async function prepareReviewWorkspace({
  stateRoot,
  replicaId,
  repository,
  remoteUrl,
  baseSha,
  headSha,
  gitExecutable,
  environment,
  runCommand = run,
}) {
  const workspace = await loadRegisteredWorkspace(stateRoot, replicaId)
  requiredText(gitExecutable, 'review workspace gitExecutable')
  requiredText(remoteUrl, 'review workspace remoteUrl')
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository || '')) {
    throw new Error('Review workspace repository must be owner/name')
  }
  const normalizedBase = requiredSha(baseSha, 'review workspace baseSha')
  const normalizedHead = requiredSha(headSha, 'review workspace headSha')
  const gitDirectory = join(workspace.directory, '.git')
  let initialized = false
  try {
    const metadata = await lstat(gitDirectory)
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error(`Review workspace Git metadata is not one physical directory: ${gitDirectory}`)
    }
  } catch (error) {
    if (!hasErrorCode(error, 'ENOENT')) throw error
    await runCommand(gitExecutable, ['-C', workspace.directory, 'init'], { env: environment })
    initialized = true
  }

  if (!initialized) {
    const existingHead = await runCommand(gitExecutable, [
      '-C', workspace.directory, 'rev-parse', '--verify', 'HEAD',
    ], { env: environment }).catch(() => null)
    if (existingHead) await runCommand(gitExecutable, ['-C', workspace.directory, 'reset', '--hard'], { env: environment })
  }
  await runCommand(gitExecutable, ['-C', workspace.directory, 'clean', '-ffdx'], { env: environment })
  const currentRemote = await runCommand(gitExecutable, [
    '-C', workspace.directory, 'remote', 'get-url', 'origin',
  ], { env: environment }).catch(() => null)
  await runCommand(gitExecutable, [
    '-C', workspace.directory, 'remote', currentRemote ? 'set-url' : 'add', 'origin', remoteUrl,
  ], { env: environment })
  await runCommand(gitExecutable, [
    '-C', workspace.directory, 'fetch', '--force', '--no-tags', 'origin',
    `+${normalizedBase}:refs/agent-automation/base`,
    `+${normalizedHead}:refs/agent-automation/head`,
  ], { env: gitFetchEnvironment(environment, remoteUrl) })
  await runCommand(gitExecutable, [
    '-C', workspace.directory, 'checkout', '--detach', '--force', 'refs/agent-automation/head',
  ], { env: environment })
  await runCommand(gitExecutable, ['-C', workspace.directory, 'reset', '--hard', normalizedHead], { env: environment })
  await runCommand(gitExecutable, ['-C', workspace.directory, 'clean', '-ffdx'], { env: environment })

  const actualHead = (await runCommand(gitExecutable, [
    '-C', workspace.directory, 'rev-parse', 'HEAD',
  ], { env: environment })).stdout.trim().toLowerCase()
  const actualBase = (await runCommand(gitExecutable, [
    '-C', workspace.directory, 'rev-parse', 'refs/agent-automation/base^{commit}',
  ], { env: environment })).stdout.trim().toLowerCase()
  if (actualHead !== normalizedHead || actualBase !== normalizedBase) {
    throw new Error(`Review workspace materialized ${actualBase}..${actualHead}, expected ${normalizedBase}..${normalizedHead}`)
  }
  const mergeBase = (await runCommand(gitExecutable, [
    '-C', workspace.directory, 'merge-base', normalizedBase, normalizedHead,
  ], { env: environment })).stdout.trim().toLowerCase()
  if (!/^[0-9a-f]{40}$/.test(mergeBase)) throw new Error('Review workspace has no valid merge base')
  return { ...workspace, base: normalizedBase, head: normalizedHead, mergeBase }
}
