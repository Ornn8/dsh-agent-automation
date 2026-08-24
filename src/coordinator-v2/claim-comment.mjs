// @ts-check

import { parseTaskClaimProjection } from './claim-policy.mjs'

const MARKER = '<!-- coordinator-v2-task-claim -->'
const SIGNATURE = 'coordinator-v2-task-claim'
const MAX_BODY_BYTES = 16 * 1024
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const FULL_SHA = /^[0-9a-f]{40}$/
const WORKFLOW_PATH = /^\.github\/workflows\/[A-Za-z0-9_.-]+\.(?:yml|yaml)$/
const LOGIN = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}(?:\[bot\])?$/
const APP_SLUG = /^[a-z0-9][a-z0-9-]{0,99}$/
const GENERIC_ACTIONS_LOGIN = 'github-actions[bot]'
const GENERIC_ACTIONS_APP = 'github-actions'
const MAX_NUMBER = Number.MAX_SAFE_INTEGER

/** @typedef {import('./claim-policy.mjs').ClaimProjection} ClaimProjection */
/** @typedef {{ repository: string, workflowPath: string, sha: string }} ControllerProvenance */
/** @typedef {{ runId: number, runAttempt: number }} ClaimSource */
/** @typedef {{ version: 1, claim: ClaimProjection, controller: ControllerProvenance, source: ClaimSource }} ClaimCommentRecord */
/** @typedef {{ login: string, type: 'Bot', appSlug: string }} AppAuthor */
/** @typedef {{ author: AppAuthor, repository: string, issueNumber: number, controller: ControllerProvenance }} ClaimCommentExpectation */
/** @typedef {{ id: number, runAttempt: number, repository: string, controller: ControllerProvenance }} SourceRunObservation */
/** @typedef {{ id: number, authorLogin: string, authorType: 'Bot', appSlug: string, body: string }} ClaimCommentObservation */
/** @typedef {(runId: number, runAttempt: number) => unknown | Promise<unknown>} SourceRunLoader */
/** @typedef {{ raw: unknown, fingerprint: string }} UnkeyedRawComment */
/** @typedef {{ raw: unknown, fingerprint: string }} KeyedRawComment */
/** @typedef {{ conflict: number | null, comments: unknown[] }} DeduplicatedRawComments */
/** @typedef {{ authenticated: true, projection: ClaimProjection }} AuthenticatedClaimObservation */
/** @typedef {{ status: 'none', reason: 'no-controller-comment' }} NoClaimCommentResult */
/** @typedef {{ status: 'invalid', reason: string, detail?: string, commentId?: number }} InvalidClaimCommentResult */
/** @typedef {{ status: 'authenticated', commentId: number, record: ClaimCommentRecord, observation: AuthenticatedClaimObservation }} AuthenticatedClaimCommentResult */
/** @typedef {NoClaimCommentResult | InvalidClaimCommentResult | AuthenticatedClaimCommentResult} ClaimCommentSelection */

/**
 * @param {unknown} value
 * @returns {Record<string, unknown> | null}
 */
function objectRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? /** @type {Record<string, unknown>} */ (value)
    : null
}

/**
 * Read properties from object/function-shaped in-process values without treating a
 * function as an ordinary JSON record.
 *
 * @param {unknown} value
 * @returns {Record<string, unknown> | null}
 */
function propertyCarrier(value) {
  if ((typeof value !== 'object' || value === null) && typeof value !== 'function') return null
  return /** @type {Record<string, unknown>} */ (value)
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * @param {unknown} value
 * @param {string[]} expected
 * @param {string} name
 * @returns {Record<string, unknown>}
 */
function exactKeys(value, expected, name) {
  const record = objectRecord(value)
  const fields = record ? Object.keys(record).sort() : []
  const wanted = [...expected].sort()
  if (!record || fields.length !== wanted.length || fields.some((field, index) => field !== wanted[index])) {
    throw new Error(`${name} has missing or unknown fields`)
  }
  return record
}

/**
 * @param {unknown} value
 * @param {string} name
 * @returns {number}
 */
function positiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || /** @type {number} */ (value) < 1 || /** @type {number} */ (value) > MAX_NUMBER) {
    throw new Error(`${name} must be a positive safe integer`)
  }
  return /** @type {number} */ (value)
}

/**
 * @param {unknown} value
 * @param {string} name
 * @returns {string}
 */
function repositoryName(value, name) {
  if (typeof value !== 'string' || !REPOSITORY.test(value)) {
    throw new Error(`${name} must use owner/name form`)
  }
  return value.toLowerCase()
}

/** @param {unknown} value @returns {string} */
function workflowPath(value) {
  if (typeof value !== 'string' || !WORKFLOW_PATH.test(value)) {
    throw new Error('Controller workflow path is invalid')
  }
  return value
}

/** @param {unknown} value @returns {string} */
function fullSha(value) {
  if (typeof value !== 'string' || !FULL_SHA.test(value)) {
    throw new Error('Controller revision must be a full lowercase SHA')
  }
  return value
}

/** @param {unknown} value @returns {ControllerProvenance} */
function normalizeController(value) {
  const record = exactKeys(value, ['repository', 'sha', 'workflowPath'], 'Controller provenance')
  return {
    repository: repositoryName(record.repository, 'Controller repository'),
    workflowPath: workflowPath(record.workflowPath),
    sha: fullSha(record.sha),
  }
}

/** @param {unknown} value @returns {ClaimSource} */
function normalizeSource(value) {
  const record = exactKeys(value, ['runAttempt', 'runId'], 'Claim source')
  return {
    runId: positiveInteger(record.runId, 'Source run id'),
    runAttempt: positiveInteger(record.runAttempt, 'Source run attempt'),
  }
}

/** @param {unknown} value @returns {ClaimCommentRecord} */
function normalizeRecord(value) {
  const record = exactKeys(value, ['claim', 'controller', 'source', 'version'], 'Claim comment payload')
  if (record.version !== 1) throw new Error('Claim comment payload version must be 1')
  return {
    version: 1,
    claim: parseTaskClaimProjection(record.claim),
    controller: normalizeController(record.controller),
    source: normalizeSource(record.source),
  }
}

/** @param {unknown} value @param {string} [name] @returns {AppAuthor} */
function normalizeAuthor(value, name = 'Comment author') {
  const record = exactKeys(value, ['appSlug', 'login', 'type'], name)
  if (typeof record.login !== 'string' || !LOGIN.test(record.login)
    || record.type !== 'Bot'
    || typeof record.appSlug !== 'string' || !APP_SLUG.test(record.appSlug)) {
    throw new Error(`${name} identity is invalid`)
  }
  return { login: record.login, type: 'Bot', appSlug: record.appSlug }
}

/** @param {AppAuthor} author @returns {AppAuthor} */
function requireDedicatedAuthor(author) {
  if (!author.login.endsWith('[bot]')
    || author.login.toLowerCase() === GENERIC_ACTIONS_LOGIN
    || author.appSlug === GENERIC_ACTIONS_APP) {
    throw new Error('Expected comment author must be a dedicated claim-writer GitHub App')
  }
  return author
}

/** @param {unknown} value @returns {ClaimCommentExpectation} */
function normalizeExpected(value) {
  const record = exactKeys(value, ['author', 'controller', 'issueNumber', 'repository'], 'Claim comment expectation')
  return {
    author: requireDedicatedAuthor(normalizeAuthor(record.author, 'Expected comment author')),
    repository: repositoryName(record.repository, 'Expected repository'),
    issueNumber: positiveInteger(record.issueNumber, 'Expected Issue number'),
    controller: normalizeController(record.controller),
  }
}

/** @param {unknown} value @returns {SourceRunObservation} */
function normalizeRun(value) {
  const record = exactKeys(value, ['controller', 'id', 'repository', 'runAttempt'], 'Source run observation')
  return {
    id: positiveInteger(record.id, 'Observed run id'),
    runAttempt: positiveInteger(record.runAttempt, 'Observed run attempt'),
    repository: repositoryName(record.repository, 'Observed run repository'),
    controller: normalizeController(record.controller),
  }
}

/** @param {unknown} value @returns {ClaimCommentObservation} */
function normalizeComment(value) {
  const record = exactKeys(value, ['appSlug', 'authorLogin', 'authorType', 'body', 'id'], 'Claim comment observation')
  const id = positiveInteger(record.id, 'Comment id')
  if (typeof record.body !== 'string' || Buffer.byteLength(record.body, 'utf8') > MAX_BODY_BYTES) {
    throw new Error('Claim comment body is invalid or too large')
  }
  const author = normalizeAuthor({
    login: record.authorLogin,
    type: record.authorType,
    appSlug: record.appSlug,
  })
  return {
    id,
    authorLogin: author.login,
    authorType: author.type,
    appSlug: author.appSlug,
    body: record.body,
  }
}

/** @param {ControllerProvenance} left @param {ControllerProvenance} right @returns {boolean} */
function sameControllerAuthority(left, right) {
  return left.repository === right.repository
    && left.workflowPath === right.workflowPath
}

/** @param {ControllerProvenance} left @param {ControllerProvenance} right @returns {boolean} */
function sameControllerRevision(left, right) {
  return sameControllerAuthority(left, right) && left.sha === right.sha
}

/** @param {unknown} raw @param {AppAuthor} expected @returns {boolean} */
function expectedAuthor(raw, expected) {
  const record = objectRecord(raw)
  return Boolean(record
    && record.authorLogin === expected.login
    && record.authorType === expected.type
    && record.appSlug === expected.appSlug)
}

/** @param {unknown} value @returns {unknown[]} */
function fingerprintPart(value) {
  if (value === undefined) return ['undefined']
  if (value === null) return ['null']
  const type = typeof value
  if (type === 'string' || type === 'boolean') return [type, value]
  if (type === 'number') return [type, Number.isNaN(value) ? 'NaN' : String(value)]
  return [type, Object.prototype.toString.call(value)]
}

/** @param {unknown} raw @returns {string} */
function rawCommentFingerprint(raw) {
  const record = objectRecord(raw)
  const carrier = propertyCarrier(raw)
  const fields = record ? Object.keys(record).sort() : []
  return JSON.stringify([
    fields,
    fingerprintPart(carrier?.id),
    fingerprintPart(carrier?.authorLogin),
    fingerprintPart(carrier?.authorType),
    fingerprintPart(carrier?.appSlug),
    fingerprintPart(carrier?.body),
  ])
}

/** @param {unknown[]} comments @returns {DeduplicatedRawComments} */
function deduplicateRawComments(comments) {
  /** @type {Map<number, KeyedRawComment>} */
  const keyed = new Map()
  /** @type {UnkeyedRawComment[]} */
  const unkeyed = []
  for (const raw of comments) {
    const record = objectRecord(raw)
    const id = record && Number.isSafeInteger(record.id) && /** @type {number} */ (record.id) > 0
      ? /** @type {number} */ (record.id)
      : null
    const fingerprint = rawCommentFingerprint(raw)
    if (id === null) {
      unkeyed.push({ raw, fingerprint })
      continue
    }
    const previous = keyed.get(id)
    if (previous && previous.fingerprint !== fingerprint) {
      return { conflict: id, comments: [] }
    }
    if (!previous) keyed.set(id, { raw, fingerprint })
  }
  const commentsById = [...keyed.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, entry]) => entry.raw)
  const commentsWithoutId = unkeyed
    .sort((left, right) => left.fingerprint.localeCompare(right.fingerprint))
    .map(entry => entry.raw)
  return { conflict: null, comments: [...commentsById, ...commentsWithoutId] }
}

/** @param {ClaimCommentRecord} record @returns {string} */
function renderNormalized(record) {
  const subject = `${record.claim.repository}#${record.claim.issueNumber}`
  return [
    MARKER,
    '## Coordinator V2 task claim',
    '',
    `- Subject: \`${subject}\``,
    `- Claim: \`${record.claim.claimId}\``,
    `- Claimant: \`${record.claim.claimant}\``,
    `- Expires: \`${record.claim.expiresAt}\``,
    '',
    '```json',
    JSON.stringify(record, null, 2),
    '```',
  ].join('\n')
}

/** @param {unknown} value @returns {string} */
export function renderClaimComment(value) {
  const body = renderNormalized(normalizeRecord(value))
  if (Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES) {
    throw new Error('Claim comment body is too large')
  }
  return body
}

/** @param {unknown} body @returns {ClaimCommentRecord | null} */
export function parseClaimComment(body) {
  if (typeof body !== 'string' || !body.includes(SIGNATURE)) return null
  if (Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES) {
    throw new Error('Claim comment body is too large')
  }
  const markerCount = body.split(MARKER).length - 1
  const codeMarker = '\n```json\n'
  const codeCount = body.split(codeMarker).length - 1
  if (markerCount !== 1 || codeCount !== 1 || !body.startsWith(`${MARKER}\n`) || !body.endsWith('\n```')) {
    throw new Error('Claim comment must use one canonical marker and payload')
  }

  const start = body.indexOf(codeMarker) + codeMarker.length
  const end = body.length - '\n```'.length
  /** @type {unknown} */
  let value
  try {
    value = JSON.parse(body.slice(start, end))
  } catch (error) {
    throw new Error(`Claim comment payload is not valid JSON: ${errorMessage(error)}`, { cause: error })
  }
  const record = normalizeRecord(value)
  if (renderNormalized(record) !== body) throw new Error('Claim comment is not canonical')
  return record
}

/**
 * @param {{ comment?: unknown, expected?: unknown, loadRun?: unknown }} input
 * @returns {Promise<ClaimCommentRecord>}
 */
export async function verifyClaimComment({ comment, expected, loadRun }) {
  const normalizedExpected = normalizeExpected(expected)
  if (typeof loadRun !== 'function') throw new Error('Source run loader is required')
  const runLoader = /** @type {SourceRunLoader} */ (loadRun)
  const normalizedComment = normalizeComment(comment)
  if (!expectedAuthor(normalizedComment, normalizedExpected.author)) {
    throw new Error('Claim comment author is not trusted')
  }
  const record = parseClaimComment(normalizedComment.body)
  if (!record) throw new Error('Claim comment marker is missing')
  if (record.claim.repository !== normalizedExpected.repository
    || record.claim.issueNumber !== normalizedExpected.issueNumber) {
    throw new Error('Claim comment does not identify the expected Issue')
  }
  if (!sameControllerAuthority(record.controller, normalizedExpected.controller)) {
    throw new Error('Claim comment controller authority is not trusted')
  }

  const observedRun = normalizeRun(await runLoader(record.source.runId, record.source.runAttempt))
  if (observedRun.id !== record.source.runId
    || observedRun.runAttempt < record.source.runAttempt
    || observedRun.repository !== record.controller.repository
    || !sameControllerRevision(observedRun.controller, record.controller)) {
    throw new Error('Claim comment does not match its recorded Controller run provenance')
  }
  return record
}

/**
 * @param {{ comments?: unknown, expected?: unknown, loadRun?: unknown }} input
 * @returns {Promise<ClaimCommentSelection>}
 */
export async function selectClaimCommentObservation({ comments, expected, loadRun }) {
  /** @type {ClaimCommentExpectation} */
  let normalizedExpected
  /** @type {SourceRunLoader} */
  let runLoader
  try {
    normalizedExpected = normalizeExpected(expected)
    if (!Array.isArray(comments)) throw new Error('Claim comments must be an array')
    if (typeof loadRun !== 'function') throw new Error('Source run loader is required')
    runLoader = /** @type {SourceRunLoader} */ (loadRun)
  } catch (error) {
    return { status: 'invalid', reason: 'invalid-input', detail: errorMessage(error) }
  }

  const deduplicated = deduplicateRawComments(comments)
  if (deduplicated.conflict !== null) {
    return {
      status: 'invalid',
      reason: 'conflicting-comment-observation',
      commentId: deduplicated.conflict,
    }
  }

  /** @type {Map<number, ClaimCommentObservation>} */
  const candidates = new Map()
  for (const raw of deduplicated.comments) {
    if (!expectedAuthor(raw, normalizedExpected.author)) continue

    /** @type {ClaimCommentObservation} */
    let comment
    try {
      comment = normalizeComment(raw)
    } catch (error) {
      return { status: 'invalid', reason: 'malformed-controller-comment', detail: errorMessage(error) }
    }
    candidates.set(comment.id, comment)
    if (candidates.size > 1) {
      return { status: 'invalid', reason: 'duplicate-controller-comments' }
    }
  }

  if (candidates.size === 0) return { status: 'none', reason: 'no-controller-comment' }
  const comment = /** @type {ClaimCommentObservation} */ ([...candidates.values()][0])
  try {
    const record = await verifyClaimComment({ comment, expected: normalizedExpected, loadRun: runLoader })
    return {
      status: 'authenticated',
      commentId: comment.id,
      record,
      observation: { authenticated: true, projection: record.claim },
    }
  } catch (error) {
    return { status: 'invalid', reason: 'invalid-controller-comment', detail: errorMessage(error) }
  }
}

export const claimCommentMarker = MARKER
