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

function exactKeys(value, expected, name) {
  const fields = value && typeof value === 'object' && !Array.isArray(value)
    ? Object.keys(value).sort()
    : []
  const wanted = [...expected].sort()
  if (fields.length !== wanted.length || fields.some((field, index) => field !== wanted[index])) {
    throw new Error(`${name} has missing or unknown fields`)
  }
}

function positiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_NUMBER) {
    throw new Error(`${name} must be a positive safe integer`)
  }
  return value
}

function repositoryName(value, name) {
  if (typeof value !== 'string' || !REPOSITORY.test(value)) {
    throw new Error(`${name} must use owner/name form`)
  }
  return value.toLowerCase()
}

function workflowPath(value) {
  if (typeof value !== 'string' || !WORKFLOW_PATH.test(value)) {
    throw new Error('Controller workflow path is invalid')
  }
  return value
}

function fullSha(value) {
  if (typeof value !== 'string' || !FULL_SHA.test(value)) {
    throw new Error('Controller revision must be a full lowercase SHA')
  }
  return value
}

function normalizeController(value) {
  exactKeys(value, ['repository', 'sha', 'workflowPath'], 'Controller provenance')
  return {
    repository: repositoryName(value.repository, 'Controller repository'),
    workflowPath: workflowPath(value.workflowPath),
    sha: fullSha(value.sha),
  }
}

function normalizeSource(value) {
  exactKeys(value, ['runAttempt', 'runId'], 'Claim source')
  return {
    runId: positiveInteger(value.runId, 'Source run id'),
    runAttempt: positiveInteger(value.runAttempt, 'Source run attempt'),
  }
}

function normalizeRecord(value) {
  exactKeys(value, ['claim', 'controller', 'source', 'version'], 'Claim comment payload')
  if (value.version !== 1) throw new Error('Claim comment payload version must be 1')
  return {
    version: 1,
    claim: parseTaskClaimProjection(value.claim),
    controller: normalizeController(value.controller),
    source: normalizeSource(value.source),
  }
}

function normalizeAuthor(value, name = 'Comment author') {
  exactKeys(value, ['appSlug', 'login', 'type'], name)
  if (typeof value.login !== 'string' || !LOGIN.test(value.login)
    || value.type !== 'Bot'
    || typeof value.appSlug !== 'string' || !APP_SLUG.test(value.appSlug)) {
    throw new Error(`${name} identity is invalid`)
  }
  return { login: value.login, type: 'Bot', appSlug: value.appSlug }
}

function requireDedicatedAuthor(author) {
  if (!author.login.endsWith('[bot]')
    || author.login.toLowerCase() === GENERIC_ACTIONS_LOGIN
    || author.appSlug === GENERIC_ACTIONS_APP) {
    throw new Error('Expected comment author must be a dedicated claim-writer GitHub App')
  }
  return author
}

function normalizeExpected(value) {
  exactKeys(value, ['author', 'controller', 'issueNumber', 'repository'], 'Claim comment expectation')
  return {
    author: requireDedicatedAuthor(normalizeAuthor(value.author, 'Expected comment author')),
    repository: repositoryName(value.repository, 'Expected repository'),
    issueNumber: positiveInteger(value.issueNumber, 'Expected Issue number'),
    controller: normalizeController(value.controller),
  }
}

function normalizeRun(value) {
  exactKeys(value, ['controller', 'id', 'repository', 'runAttempt'], 'Source run observation')
  return {
    id: positiveInteger(value.id, 'Observed run id'),
    runAttempt: positiveInteger(value.runAttempt, 'Observed run attempt'),
    repository: repositoryName(value.repository, 'Observed run repository'),
    controller: normalizeController(value.controller),
  }
}

function normalizeComment(value) {
  exactKeys(value, ['appSlug', 'authorLogin', 'authorType', 'body', 'id'], 'Claim comment observation')
  positiveInteger(value.id, 'Comment id')
  if (typeof value.body !== 'string' || Buffer.byteLength(value.body, 'utf8') > MAX_BODY_BYTES) {
    throw new Error('Claim comment body is invalid or too large')
  }
  normalizeAuthor({
    login: value.authorLogin,
    type: value.authorType,
    appSlug: value.appSlug,
  })
  return {
    id: value.id,
    authorLogin: value.authorLogin,
    authorType: value.authorType,
    appSlug: value.appSlug,
    body: value.body,
  }
}

function sameController(left, right) {
  return left.repository === right.repository
    && left.workflowPath === right.workflowPath
    && left.sha === right.sha
}

function expectedAuthor(raw, expected) {
  return raw && typeof raw === 'object' && !Array.isArray(raw)
    && raw.authorLogin === expected.login
    && raw.authorType === expected.type
    && raw.appSlug === expected.appSlug
}

function fingerprintPart(value) {
  if (value === undefined) return ['undefined']
  if (value === null) return ['null']
  const type = typeof value
  if (type === 'string' || type === 'boolean') return [type, value]
  if (type === 'number') return [type, Number.isNaN(value) ? 'NaN' : String(value)]
  return [type, Object.prototype.toString.call(value)]
}

function rawCommentFingerprint(raw) {
  const fields = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? Object.keys(raw).sort()
    : []
  return JSON.stringify([
    fields,
    fingerprintPart(raw?.id),
    fingerprintPart(raw?.authorLogin),
    fingerprintPart(raw?.authorType),
    fingerprintPart(raw?.appSlug),
    fingerprintPart(raw?.body),
  ])
}

function deduplicateRawComments(comments) {
  const keyed = new Map()
  const unkeyed = []
  for (const raw of comments) {
    const id = raw && typeof raw === 'object' && !Array.isArray(raw)
      && Number.isSafeInteger(raw.id) && raw.id > 0
      ? raw.id
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

export function renderClaimComment(value) {
  const body = renderNormalized(normalizeRecord(value))
  if (Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES) {
    throw new Error('Claim comment body is too large')
  }
  return body
}

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
  let value
  try {
    value = JSON.parse(body.slice(start, end))
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`Claim comment payload is not valid JSON: ${detail}`, { cause: error })
  }
  const record = normalizeRecord(value)
  if (renderNormalized(record) !== body) throw new Error('Claim comment is not canonical')
  return record
}

export async function verifyClaimComment({ comment, expected, loadRun }) {
  const normalizedExpected = normalizeExpected(expected)
  if (typeof loadRun !== 'function') throw new Error('Source run loader is required')
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
  if (!sameController(record.controller, normalizedExpected.controller)) {
    throw new Error('Claim comment controller provenance is not trusted')
  }

  const observedRun = normalizeRun(await loadRun(record.source.runId))
  if (observedRun.id !== record.source.runId
    || observedRun.runAttempt !== record.source.runAttempt
    || observedRun.repository !== normalizedExpected.repository
    || !sameController(observedRun.controller, normalizedExpected.controller)) {
    throw new Error('Claim comment does not match its named Actions run provenance')
  }
  return record
}

export async function selectClaimCommentObservation({ comments, expected, loadRun }) {
  let normalizedExpected
  try {
    normalizedExpected = normalizeExpected(expected)
    if (!Array.isArray(comments)) throw new Error('Claim comments must be an array')
    if (typeof loadRun !== 'function') throw new Error('Source run loader is required')
  } catch (error) {
    return { status: 'invalid', reason: 'invalid-input', detail: error.message }
  }

  const deduplicated = deduplicateRawComments(comments)
  if (deduplicated.conflict !== null) {
    return {
      status: 'invalid',
      reason: 'conflicting-comment-observation',
      commentId: deduplicated.conflict,
    }
  }

  const candidates = new Map()
  for (const raw of deduplicated.comments) {
    if (!expectedAuthor(raw, normalizedExpected.author)) continue

    let comment
    try {
      comment = normalizeComment(raw)
    } catch (error) {
      return { status: 'invalid', reason: 'malformed-controller-comment', detail: error.message }
    }
    candidates.set(comment.id, comment)
    if (candidates.size > 1) {
      return { status: 'invalid', reason: 'duplicate-controller-comments' }
    }
  }

  if (candidates.size === 0) return { status: 'none', reason: 'no-controller-comment' }
  const comment = [...candidates.values()][0]
  try {
    const record = await verifyClaimComment({ comment, expected: normalizedExpected, loadRun })
    return {
      status: 'authenticated',
      commentId: comment.id,
      record,
      observation: { authenticated: true, projection: record.claim },
    }
  } catch (error) {
    return { status: 'invalid', reason: 'invalid-controller-comment', detail: error.message }
  }
}

export const claimCommentMarker = MARKER
