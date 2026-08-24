// @ts-check

const SHA_PATTERN = /^[0-9a-f]{40}$/
const MAX_REQUIRED_CHECKS = 32
const MAX_RELEVANT_CHECK_RUNS = 2_048
const MAX_CHECK_NAME_BYTES = 256
const INPUT_FIELDS = ['checkSnapshot', 'headSha', 'requiredChecks']
const SNAPSHOT_FIELDS = ['checkRuns', 'complete', 'headSha']
const REQUIRED_FIELDS = ['appId', 'name']
const CHECK_FIELDS = ['appId', 'conclusion', 'headSha', 'id', 'name', 'status']
const CHECK_STATUSES = new Set(['completed', 'in_progress', 'pending', 'queued', 'requested', 'waiting'])
const CHECK_CONCLUSIONS = new Set([
  'action_required', 'cancelled', 'failure', 'neutral', 'skipped',
  'stale', 'startup_failure', 'success', 'timed_out',
])
const PASSING_CONCLUSIONS = new Set(['neutral', 'skipped', 'success'])

/** @typedef {{ name: string, appId: number }} RequiredCheck */
/** @typedef {'missing' | 'pending' | 'passed' | 'failed'} RequiredCheckStatus */
/** @typedef {{ name: string, appId: number, status: RequiredCheckStatus, checkRunId: number | null }} RequiredCheckObservation */
/** @typedef {{ headSha: string, status: 'pending' | 'passed' | 'failed', checks: RequiredCheckObservation[] }} CiObservation */
/** @typedef {{ id: number, name: string, appId: number, headSha: string, status: 'completed' | 'in_progress' | 'pending' | 'queued' | 'requested' | 'waiting', conclusion: null | 'action_required' | 'cancelled' | 'failure' | 'neutral' | 'skipped' | 'stale' | 'startup_failure' | 'success' | 'timed_out' }} NormalizedCheckRun */
/** @typedef {{ status: 'ok', ci: CiObservation } | { status: 'invalid', reason: 'invalid-input', detail: string }} ExactHeadCiResult */

/** @param {unknown} value @returns {Record<string, unknown> | null} */
function objectRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? /** @type {Record<string, unknown>} */ (value)
    : null
}

/** @param {unknown} value @param {string[]} expected @param {string} name @returns {Record<string, unknown>} */
function exactObject(value, expected, name) {
  const record = objectRecord(value)
  if (!record) throw new Error(`${name} must be an object`)
  const fields = Object.keys(record).sort()
  if (fields.length !== expected.length || fields.some((field, index) => field !== expected[index])) {
    throw new Error(`${name} has missing or unknown fields`)
  }
  return record
}

/** @param {unknown} value @param {string} name @returns {number} */
function positiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || /** @type {number} */ (value) < 1) {
    throw new Error(`${name} must be a positive safe integer`)
  }
  return /** @type {number} */ (value)
}

/** @param {unknown} value @param {string} name @returns {string} */
function fullSha(value, name) {
  if (typeof value !== 'string' || !SHA_PATTERN.test(value)) throw new Error(`${name} must be a full lowercase SHA`)
  return value
}

/** @param {unknown} value @param {string} name @returns {string} */
function checkName(value, name) {
  if (typeof value !== 'string' || !value || value !== value.trim()
    || /[\u0000-\u001f\u007f]/.test(value)
    || Buffer.byteLength(value, 'utf8') > MAX_CHECK_NAME_BYTES) {
    throw new Error(`${name} must be a bounded canonical string`)
  }
  return value
}

/** @param {unknown} value @returns {RequiredCheck[]} */
function normalizeRequiredChecks(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_REQUIRED_CHECKS) {
    throw new Error(`Required checks must contain from 1 through ${MAX_REQUIRED_CHECKS} entries`)
  }
  const identities = new Set()
  const normalized = value.map((candidate, index) => {
    const record = exactObject(candidate, REQUIRED_FIELDS, `Required check #${index + 1}`)
    const name = checkName(record.name, `Required check #${index + 1} name`)
    const appId = positiveInteger(record.appId, `Required check #${index + 1} app id`)
    const identity = `${name}\u0000${appId}`
    if (identities.has(identity)) throw new Error('Required check identities must be unique')
    identities.add(identity)
    return { name, appId }
  })
  return normalized.sort((left, right) => left.name.localeCompare(right.name) || left.appId - right.appId)
}

/** @param {unknown} value @returns {NormalizedCheckRun} */
function normalizeCheckRun(value) {
  const record = exactObject(value, CHECK_FIELDS, 'CheckRun observation')
  const status = record.status
  if (typeof status !== 'string' || !CHECK_STATUSES.has(status)) throw new Error('CheckRun status is invalid')
  const conclusion = record.conclusion
  if (conclusion !== null && (typeof conclusion !== 'string' || !CHECK_CONCLUSIONS.has(conclusion))) {
    throw new Error('CheckRun conclusion is invalid')
  }
  if (status === 'completed' ? conclusion === null : conclusion !== null) {
    throw new Error(status === 'completed'
      ? 'Completed CheckRun must have a conclusion'
      : 'Incomplete CheckRun cannot have a conclusion')
  }
  return {
    id: positiveInteger(record.id, 'CheckRun id'),
    name: checkName(record.name, 'CheckRun name'),
    appId: positiveInteger(record.appId, 'CheckRun app id'),
    headSha: fullSha(record.headSha, 'CheckRun head SHA'),
    status: /** @type {NormalizedCheckRun['status']} */ (status),
    conclusion: /** @type {NormalizedCheckRun['conclusion']} */ (conclusion),
  }
}

/** @param {unknown} value @param {string} headSha @param {RequiredCheck[]} required @returns {NormalizedCheckRun[]} */
function normalizeSnapshot(value, headSha, required) {
  const record = exactObject(value, SNAPSHOT_FIELDS, 'CheckRun snapshot')
  if (record.complete !== true) throw new Error('CheckRun snapshot is incomplete')
  if (fullSha(record.headSha, 'CheckRun snapshot head SHA') !== headSha) {
    throw new Error('CheckRun snapshot does not match the current head')
  }
  if (!Array.isArray(record.checkRuns)) throw new Error('CheckRun snapshot must contain an array')
  /** @type {Map<string, Set<number>>} */
  const requiredByName = new Map()
  for (const identity of required) {
    const appIds = requiredByName.get(identity.name) || new Set()
    appIds.add(identity.appId)
    requiredByName.set(identity.name, appIds)
  }
  /** @type {Map<number, NormalizedCheckRun>} */
  const byId = new Map()
  let relevantCount = 0
  for (const candidate of record.checkRuns) {
    const raw = objectRecord(candidate)
    if (!raw || raw.headSha !== headSha || typeof raw.name !== 'string') continue
    const requiredApps = requiredByName.get(raw.name)
    if (!requiredApps) continue
    if (!Number.isSafeInteger(raw.appId) || /** @type {number} */ (raw.appId) < 1) {
      throw new Error('Potential required CheckRun app id is invalid')
    }
    if (!requiredApps.has(/** @type {number} */ (raw.appId))) continue
    relevantCount += 1
    if (relevantCount > MAX_RELEVANT_CHECK_RUNS) throw new Error('Relevant CheckRun snapshot is not bounded')
    const check = normalizeCheckRun(candidate)
    const previous = byId.get(check.id)
    if (previous && JSON.stringify(previous) !== JSON.stringify(check)) {
      throw new Error(`CheckRun id ${check.id} has conflicting observations`)
    }
    byId.set(check.id, check)
  }
  return [...byId.values()]
}

/** @param {NormalizedCheckRun[]} runs @param {RequiredCheck[]} required @param {string} headSha @returns {CiObservation} */
function currentCi(runs, required, headSha) {
  const checks = required.map(identity => {
    const latest = runs
      .filter(run => run.headSha === headSha && run.name === identity.name && run.appId === identity.appId)
      .sort((left, right) => right.id - left.id)[0]
    /** @type {RequiredCheckStatus} */
    let status = 'missing'
    if (latest) {
      status = latest.status !== 'completed'
        ? 'pending'
        : PASSING_CONCLUSIONS.has(/** @type {string} */ (latest.conclusion))
          ? 'passed'
          : 'failed'
    }
    return { ...identity, status, checkRunId: latest?.id ?? null }
  })
  const status = checks.some(check => check.status === 'failed')
    ? 'failed'
    : checks.every(check => check.status === 'passed')
      ? 'passed'
      : 'pending'
  return { headSha, status, checks }
}

/**
 * Select the newest app-bound CheckRun for each configured required check on one exact head.
 * @param {unknown} input
 * @returns {ExactHeadCiResult}
 */
export function selectExactHeadCi(input) {
  try {
    const root = exactObject(input, INPUT_FIELDS, 'Exact-head CI input')
    const headSha = fullSha(root.headSha, 'Current head SHA')
    const required = normalizeRequiredChecks(root.requiredChecks)
    const runs = normalizeSnapshot(root.checkSnapshot, headSha, required)
    return { status: 'ok', ci: currentCi(runs, required, headSha) }
  } catch (error) {
    return {
      status: 'invalid',
      reason: 'invalid-input',
      detail: error instanceof Error ? error.message : String(error),
    }
  }
}
