import { createHash } from 'node:crypto'

const FULL_SHA = /^[0-9a-f]{40}$/
const DIGEST = /^[0-9a-f]{64}$/
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const STATUSES = new Set([
  'observed', 'recovering', 'repairing', 'reviewing', 'deploying', 'verifying',
  'recovered', 'circuit-open',
])
const FAILURE_CLASSES = new Set(['transport', 'auth-quota', 'protocol', 'task', 'host', 'permissions'])
const ATTEMPT_KINDS = new Set(['deterministic', 'maintenance-worker', 'review', 'ci', 'promotion', 'verification'])
const ATTEMPT_OUTCOMES = new Set(['started', 'succeeded', 'failed'])
const DAY_MS = 24 * 60 * 60 * 1000

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function digest(value) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex')
}

function exactKeys(value, allowed, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} must be an object`)
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new Error(`${name} has unknown field ${key}`)
  }
  return value
}

function identifier(value, name) {
  if (typeof value !== 'string' || !IDENTIFIER.test(value)) throw new Error(`${name} must be a bounded identifier`)
  return value
}

function timestamp(value, name) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new Error(`${name} must be an ISO timestamp`)
  return new Date(value).toISOString()
}

function boundedText(value, name, maximum = 500) {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || /[\r\n]/.test(value)) {
    throw new Error(`${name} must be bounded one-line text`)
  }
  return value.trim()
}

function requestIds(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 100) {
    throw new Error('FaultRecord rootRequestIds must contain from 1 to 100 ids')
  }
  const normalized = value.map((item, index) => identifier(item, `FaultRecord rootRequestIds[${index}]`))
  return [...new Set(normalized)].sort()
}

/** Return the stable identity of one root infrastructure failure. */
export function faultIdentity({ repository, component, operation, failureClass, errorCode }) {
  if (!REPOSITORY.test(repository || '')) throw new Error('fault repository is invalid')
  identifier(component, 'fault component')
  identifier(operation, 'fault operation')
  if (!FAILURE_CLASSES.has(failureClass)) throw new Error('fault failureClass is unsupported')
  const normalizedErrorCode = boundedText(errorCode, 'fault errorCode', 200).toLowerCase()
    .replace(/0x[0-9a-f]+/g, '<hex>')
    .replace(/\b\d{4,}\b/g, '<number>')
    .replace(/\s+/g, ' ')
  return digest({ repository: repository.toLowerCase(), component, operation, failureClass, errorCode: normalizedErrorCode })
}

/** Build a meaningful recovery state version; wall-clock time is intentionally excluded. */
export function faultStateVersion(value) {
  const object = exactKeys(value, [
    'controllerSha', 'runtimeSnapshotHash', 'configRevision', 'credentialRevision',
    'healthGeneration', 'failureSignature',
  ], 'fault stateVersion')
  if (!FULL_SHA.test(object.controllerSha || '')) throw new Error('fault stateVersion controllerSha must be a full lowercase SHA')
  if (!DIGEST.test(object.runtimeSnapshotHash || '')) throw new Error('fault stateVersion runtimeSnapshotHash must be a SHA-256 digest')
  const configRevision = identifier(object.configRevision, 'fault stateVersion configRevision')
  const credentialRevision = identifier(object.credentialRevision, 'fault stateVersion credentialRevision')
  if (!Number.isSafeInteger(object.healthGeneration) || object.healthGeneration < 0) {
    throw new Error('fault stateVersion healthGeneration must be a non-negative integer')
  }
  const failureSignature = boundedText(object.failureSignature, 'fault stateVersion failureSignature', 200)
  const normalized = {
    controllerSha: object.controllerSha,
    runtimeSnapshotHash: object.runtimeSnapshotHash,
    configRevision,
    credentialRevision,
    healthGeneration: object.healthGeneration,
    failureSignature,
  }
  return { ...normalized, hash: digest(normalized) }
}

function normalizeStateVersion(value) {
  const { hash, ...fields } = exactKeys(value, [
    'controllerSha', 'runtimeSnapshotHash', 'configRevision', 'credentialRevision',
    'healthGeneration', 'failureSignature', 'hash',
  ], 'FaultRecord stateVersion')
  const normalized = faultStateVersion(fields)
  if (hash !== undefined && hash !== normalized.hash) throw new Error('FaultRecord stateVersion hash is invalid')
  return normalized
}

function normalizeAttempt(value, index) {
  const object = exactKeys(value, ['epoch', 'kind', 'target', 'sequence', 'outcome', 'at', 'detail'], `FaultRecord attempt ${index}`)
  if (!Number.isSafeInteger(object.epoch) || object.epoch < 1) throw new Error('FaultRecord attempt epoch is invalid')
  if (!ATTEMPT_KINDS.has(object.kind)) throw new Error('FaultRecord attempt kind is invalid')
  const target = identifier(object.target, 'FaultRecord attempt target')
  if (!Number.isSafeInteger(object.sequence) || object.sequence < 1) throw new Error('FaultRecord attempt sequence is invalid')
  if (!ATTEMPT_OUTCOMES.has(object.outcome)) throw new Error('FaultRecord attempt outcome is invalid')
  return {
    epoch: object.epoch,
    kind: object.kind,
    target,
    sequence: object.sequence,
    outcome: object.outcome,
    at: timestamp(object.at, 'FaultRecord attempt at'),
    ...(object.detail === undefined ? {} : { detail: boundedText(object.detail, 'FaultRecord attempt detail') }),
  }
}

function normalizeEpoch(value, index) {
  const object = exactKeys(value, ['number', 'openedAt', 'closedAt', 'stateVersionHash'], `FaultRecord epoch ${index}`)
  if (!Number.isSafeInteger(object.number) || object.number !== index + 1) throw new Error('FaultRecord epochs must be contiguous')
  if (!DIGEST.test(object.stateVersionHash || '')) throw new Error('FaultRecord epoch stateVersionHash is invalid')
  return {
    number: object.number,
    openedAt: timestamp(object.openedAt, 'FaultRecord epoch openedAt'),
    ...(object.closedAt === undefined ? {} : { closedAt: timestamp(object.closedAt, 'FaultRecord epoch closedAt') }),
    stateVersionHash: object.stateVersionHash,
  }
}

/** Strictly validate and normalize a durable FaultRecord v1 document. */
export function parseFaultRecord(value) {
  const object = exactKeys(value, [
    'version', 'faultId', 'repository', 'component', 'operation', 'failureClass', 'errorCode',
    'rootRequestIds', 'stateVersion', 'status', 'epochs', 'attempts', 'repairPullRequest',
    'publishedSha', 'verification',
  ], 'FaultRecord')
  if (object.version !== 1) throw new Error('FaultRecord version must be 1')
  if (!DIGEST.test(object.faultId || '')) throw new Error('FaultRecord faultId is invalid')
  if (!REPOSITORY.test(object.repository || '')) throw new Error('FaultRecord repository is invalid')
  identifier(object.component, 'FaultRecord component')
  identifier(object.operation, 'FaultRecord operation')
  if (!FAILURE_CLASSES.has(object.failureClass)) throw new Error('FaultRecord failureClass is unsupported')
  const errorCode = boundedText(object.errorCode, 'FaultRecord errorCode', 200)
  const expectedId = faultIdentity({
    repository: object.repository, component: object.component, operation: object.operation,
    failureClass: object.failureClass, errorCode,
  })
  if (expectedId !== object.faultId) throw new Error('FaultRecord faultId does not match its failure identity')
  if (!STATUSES.has(object.status)) throw new Error('FaultRecord status is unsupported')
  const stateVersion = normalizeStateVersion(object.stateVersion)
  if (!Array.isArray(object.epochs) || object.epochs.length < 1) throw new Error('FaultRecord epochs must be non-empty')
  const epochs = object.epochs.map(normalizeEpoch)
  if (epochs.at(-1).stateVersionHash !== stateVersion.hash) throw new Error('FaultRecord current epoch must use the current stateVersion')
  if (!Array.isArray(object.attempts)) throw new Error('FaultRecord attempts must be an array')
  const attempts = object.attempts.map(normalizeAttempt)
  const activeEpoch = epochs.at(-1).number
  if (attempts.some(attempt => attempt.epoch > activeEpoch)) throw new Error('FaultRecord attempt references a future epoch')

  const result = {
    version: 1,
    faultId: object.faultId,
    repository: object.repository,
    component: object.component,
    operation: object.operation,
    failureClass: object.failureClass,
    errorCode,
    rootRequestIds: requestIds(object.rootRequestIds),
    stateVersion,
    status: object.status,
    epochs,
    attempts,
  }
  if (object.repairPullRequest !== undefined) {
    if (!Number.isSafeInteger(object.repairPullRequest) || object.repairPullRequest < 1) throw new Error('FaultRecord repairPullRequest is invalid')
    result.repairPullRequest = object.repairPullRequest
  }
  if (object.publishedSha !== undefined) {
    if (!FULL_SHA.test(object.publishedSha || '')) throw new Error('FaultRecord publishedSha is invalid')
    result.publishedSha = object.publishedSha
  }
  if (object.verification !== undefined) result.verification = boundedText(object.verification, 'FaultRecord verification')
  return result
}

/** Create the first epoch for one root infrastructure failure. */
export function createFaultRecord(input) {
  const now = timestamp(input.now, 'fault observation time')
  const stateVersion = faultStateVersion(input.stateVersion)
  return parseFaultRecord({
    version: 1,
    faultId: faultIdentity(input),
    repository: input.repository,
    component: input.component,
    operation: input.operation,
    failureClass: input.failureClass,
    errorCode: input.errorCode,
    rootRequestIds: input.rootRequestIds,
    stateVersion,
    status: 'observed',
    epochs: [{ number: 1, openedAt: now, stateVersionHash: stateVersion.hash }],
    attempts: [],
  })
}

function currentEpoch(record) {
  return record.epochs.at(-1).number
}

function completedAttempts(record, kind) {
  const epoch = currentEpoch(record)
  return record.attempts.filter(attempt => attempt.epoch === epoch && attempt.kind === kind && attempt.outcome !== 'started')
}

function withAttempt(record, input) {
  const epoch = currentEpoch(record)
  const duplicates = record.attempts.filter(attempt => attempt.epoch === epoch
    && attempt.kind === input.kind && attempt.target === input.target && attempt.sequence === input.sequence)
  if (duplicates.length) throw new Error('FaultRecord attempt identity was already consumed')
  return parseFaultRecord({
    ...record,
    status: input.status,
    attempts: [...record.attempts, {
      epoch, kind: input.kind, target: input.target, sequence: input.sequence,
      outcome: input.outcome, at: input.at, ...(input.detail ? { detail: input.detail } : {}),
    }],
  })
}

/** Select the next finite recovery action without invoking an Agent. */
export function nextFaultAction({ record: rawRecord, profile, maintenanceWorkers, now = new Date().toISOString() }) {
  const record = parseFaultRecord(rawRecord)
  const nowMs = Date.parse(timestamp(now, 'fault action time'))
  if (record.status === 'recovered') return { action: 'resume-original', rootRequestIds: record.rootRequestIds }
  if (record.status === 'circuit-open') return { action: 'observe-only' }
  const deterministic = completedAttempts(record, 'deterministic')
  if (!deterministic.some(attempt => attempt.outcome === 'succeeded')
    && deterministic.length < profile.deterministic.limit) {
    const sequence = deterministic.length + 1
    const prior = deterministic.at(-1)
    if (prior) {
      const readyAt = Date.parse(prior.at) + profile.deterministic.backoffSeconds[sequence - 2] * 1000
      if (nowMs < readyAt) return { action: 'wait', readyAt: new Date(readyAt).toISOString() }
    }
    return {
      action: 'deterministic',
      target: profile.deterministic.actions[(sequence - 1) % profile.deterministic.actions.length],
      sequence,
    }
  }
  if (deterministic.some(attempt => attempt.outcome === 'succeeded')) return { action: 'verify', target: profile.verification.procedure }
  const attemptedWorkers = new Set(completedAttempts(record, 'maintenance-worker').map(attempt => attempt.target))
  const worker = maintenanceWorkers.find(workerId => !attemptedWorkers.has(workerId))
  if (worker) {
    const prior = completedAttempts(record, 'maintenance-worker').at(-1)
    if (prior) {
      const readyAt = Date.parse(prior.at) + profile.repair.failoverBackoffSeconds * 1000
      if (nowMs < readyAt) return { action: 'wait', readyAt: new Date(readyAt).toISOString() }
    }
    return { action: 'maintenance-worker', target: worker, procedure: profile.repair.procedure, sequence: attemptedWorkers.size + 1 }
  }
  return { action: 'open-circuit', reason: 'maintenance-workers-exhausted' }
}

/** Record one bounded recovery attempt. */
export function recordFaultAttempt(rawRecord, input) {
  const record = parseFaultRecord(rawRecord)
  if (record.status === 'recovered' || record.status === 'circuit-open') throw new Error('FaultRecord terminal epoch cannot accept attempts')
  if (!ATTEMPT_KINDS.has(input.kind)) throw new Error('FaultRecord attempt kind is invalid')
  const outcome = input.outcome
  if (!ATTEMPT_OUTCOMES.has(outcome)) throw new Error('FaultRecord attempt outcome is invalid')
  let status = record.status
  if (input.kind === 'deterministic') status = outcome === 'succeeded' ? 'verifying' : 'recovering'
  if (input.kind === 'maintenance-worker') status = outcome === 'succeeded' ? 'reviewing' : 'repairing'
  if (input.kind === 'review') status = outcome === 'succeeded' ? 'reviewing' : 'circuit-open'
  if (input.kind === 'ci') status = outcome === 'succeeded' ? 'deploying' : 'circuit-open'
  if (input.kind === 'promotion') status = outcome === 'succeeded' ? 'verifying' : 'circuit-open'
  if (input.kind === 'verification') {
    const requiredSamples = input.requiredSamples === undefined ? 1 : input.requiredSamples
    if (!Number.isSafeInteger(requiredSamples) || requiredSamples < 1 || requiredSamples > 10) {
      throw new Error('FaultRecord verification requiredSamples is invalid')
    }
    const priorSamples = completedAttempts(record, 'verification').filter(attempt => attempt.outcome === 'succeeded').length
    status = outcome === 'succeeded' && priorSamples + 1 >= requiredSamples ? 'recovered'
      : outcome === 'succeeded' ? 'verifying' : 'circuit-open'
  }
  const next = withAttempt(record, { ...input, status })
  const projected = { ...next }
  if (input.kind === 'maintenance-worker' && outcome === 'succeeded') {
    if (!Number.isSafeInteger(input.repairPullRequest) || input.repairPullRequest < 1) {
      throw new Error('Successful maintenance attempt requires one repair pull request')
    }
    if (record.repairPullRequest !== undefined && record.repairPullRequest !== input.repairPullRequest) {
      throw new Error('FaultRecord permits only one repair pull request per epoch')
    }
    projected.repairPullRequest = input.repairPullRequest
  }
  if (input.kind === 'promotion' && outcome === 'succeeded') {
    if (!FULL_SHA.test(input.publishedSha || '')) throw new Error('Successful promotion requires a full published SHA')
    projected.publishedSha = input.publishedSha
  }
  if (input.kind === 'verification') projected.verification = input.detail
  return parseFaultRecord(projected)
}

/** Open the circuit without creating another root fault. */
export function openFaultCircuit(rawRecord, reason) {
  const record = parseFaultRecord(rawRecord)
  return parseFaultRecord({ ...record, status: 'circuit-open', verification: boundedText(reason, 'circuit reason') })
}

/** Begin a new epoch only after a meaningful state version change and within the rolling budget. */
export function beginFaultEpoch(rawRecord, { stateVersion: rawStateVersion, now, maxEpochsPer24Hours }) {
  const record = parseFaultRecord(rawRecord)
  if (!['circuit-open', 'recovered'].includes(record.status)) throw new Error('Only a terminal FaultRecord can begin a new epoch')
  const stateVersion = faultStateVersion(rawStateVersion)
  if (stateVersion.hash === record.stateVersion.hash) throw new Error('A new recovery epoch requires a changed stateVersion')
  if (!Number.isSafeInteger(maxEpochsPer24Hours) || maxEpochsPer24Hours < 1 || maxEpochsPer24Hours > 10) {
    throw new Error('maxEpochsPer24Hours is invalid')
  }
  const openedAt = timestamp(now, 'new epoch time')
  const lowerBound = Date.parse(openedAt) - DAY_MS
  const recent = record.epochs.filter(epoch => Date.parse(epoch.openedAt) >= lowerBound)
  if (recent.length >= maxEpochsPer24Hours) throw new Error('FaultRecord rolling epoch budget is exhausted')
  const closedEpochs = record.epochs.map((epoch, index) => index === record.epochs.length - 1
    ? { ...epoch, closedAt: openedAt }
    : epoch)
  return parseFaultRecord({
    ...record,
    stateVersion,
    status: 'observed',
    epochs: [...closedEpochs, {
      number: record.epochs.length + 1,
      openedAt,
      stateVersionHash: stateVersion.hash,
    }],
    repairPullRequest: undefined,
    publishedSha: undefined,
    verification: undefined,
  })
}

/** Merge another affected WorkRequest into the existing root fault. */
export function attachRootRequests(rawRecord, ids) {
  const record = parseFaultRecord(rawRecord)
  return parseFaultRecord({ ...record, rootRequestIds: requestIds([...record.rootRequestIds, ...ids]) })
}
