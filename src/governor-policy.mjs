import { createHash } from 'node:crypto'

const FULL_SHA = /^[0-9a-f]{40}$/
const SUBJECT_TYPES = new Set(['issue', 'pull-request'])
const TRANSITION = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,299}$/
const RECORD_MARKER = '<!-- automation-governor\n'
const RECORD_TRAILER = '\n-->'

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function transitionId(value) {
  if (typeof value !== 'string' || !TRANSITION.test(value)) {
    throw new Error('Governor transition must be a bounded identifier')
  }
  return value
}

/** Bind a Governor transition to one exact Workflow Definition and Stage. */
export function workflowStageTransition({ definitionHash, workflowId, stageId }) {
  if (!/^[0-9a-f]{64}$/.test(definitionHash || '')
    || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(workflowId || '')
    || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(stageId || '')) {
    throw new Error('Workflow Stage transition identity is incomplete')
  }
  return `stage:${definitionHash}:${workflowId}:${stageId}`
}

function normalizedLabels(labels) {
  if (!Array.isArray(labels)) return []
  return labels
    .map(label => typeof label === 'string' ? label : label?.name)
    .filter(label => typeof label === 'string' && !label.startsWith('agent/') && !label.startsWith('automation/'))
    .sort()
}

function normalizedSubject(subject) {
  if (!subject || !SUBJECT_TYPES.has(subject.type)
    || !Number.isSafeInteger(subject.number) || subject.number < 1) {
    throw new Error('Governor subject must identify an issue or pull request')
  }
  if (!['open', 'closed'].includes(subject.state)) throw new Error('Governor subject state must be open or closed')
  if (subject.type === 'issue') {
    if (typeof subject.title !== 'string' || typeof subject.body !== 'string') {
      throw new Error('Governor Issue state requires title and body')
    }
    return {
      type: subject.type,
      number: subject.number,
      state: subject.state,
      title: subject.title,
      body: subject.body,
      labels: normalizedLabels(subject.labels),
    }
  }
  if (typeof subject.draft !== 'boolean'
    || !FULL_SHA.test(subject.base || '') || !FULL_SHA.test(subject.head || '')) {
    throw new Error('Governor pull request state requires draft and lowercase base/head SHAs')
  }
  return {
    type: subject.type,
    number: subject.number,
    state: subject.state,
    draft: subject.draft,
    base: subject.base,
    head: subject.head,
    labels: normalizedLabels(subject.labels),
  }
}

/** Return the durable semantic version of one Issue or pull request state. */
export function subjectStateVersion(subject) {
  return createHash('sha256').update(canonicalJson(normalizedSubject(subject))).digest('hex')
}

function candidateRecord({ transition, subject, stateVersion, observationId }) {
  return {
    version: 1,
    status: 'candidate',
    transition,
    subject: { type: subject.type, number: subject.number },
    stateVersion,
    observationId,
  }
}

/**
 * Return the first matching candidate whose exact transition and subject state have not been applied.
 * @param {Array<{ status?: string, transition?: string, stateVersion?: string, subject?: { type?: string, number?: number } }>} records
 * @param {(record: { status?: string, transition?: string, stateVersion?: string, subject?: { type?: string, number?: number } }) => boolean} [predicate]
 * @returns {{ status?: string, transition?: string, stateVersion?: string, subject?: { type?: string, number?: number } } | undefined}
 */
export function unappliedGovernorCandidate(records, predicate = () => true) {
  if (!Array.isArray(records) || typeof predicate !== 'function') {
    throw new Error('Governor candidate selection requires records and a predicate')
  }
  return records.find(candidate => candidate?.status === 'candidate'
    && predicate(candidate)
    && !records.some(record => record?.status === 'applied'
      && record.transition === candidate.transition
      && record.stateVersion === candidate.stateVersion
      && record.subject?.type === candidate.subject?.type
      && record.subject?.number === candidate.subject?.number))
}

function activeGovernorEpoch(records, subject) {
  const subjectRecords = records.filter(record => record?.version === 1
    && record.subject?.type === subject.type
    && record.subject?.number === subject.number)
  let start = 0
  let openPause = null
  for (const [index, record] of subjectRecords.entries()) {
    if (record.status === 'paused') openPause = record
    if (record.status !== 'resumed') continue
    if (!openPause || record.pausedObservationId !== openPause.observationId) {
      throw new Error('Governor resume record does not match the active pause')
    }
    openPause = null
    start = index + 1
  }
  return { records: subjectRecords.slice(start), openPause }
}

function validatedRecord(value) {
  let transitionIsValid = true
  try {
    transitionId(value?.transition)
  } catch {
    transitionIsValid = false
  }
  if (!value || value.version !== 1
    || !['candidate', 'admitted', 'applied', 'attempt', 'paused', 'resumed'].includes(value.status)
    || !transitionIsValid
    || !SUBJECT_TYPES.has(value.subject?.type)
    || !Number.isSafeInteger(value.subject?.number) || value.subject.number < 1
    || typeof value.observationId !== 'string' || !value.observationId.trim()
    || value.observationId.length > 200) {
    throw new Error('Invalid governor record')
  }
  const common = ['version', 'status', 'transition', 'subject', 'observationId']
  let expected
  if (['candidate', 'applied'].includes(value.status)) {
    expected = [...common, 'stateVersion']
  } else if (value.status === 'admitted') {
    expected = [...common, 'stateVersion', 'candidateObservationId']
  } else if (value.status === 'attempt') {
    expected = [...common, 'workIdentity', 'attempt']
  } else if (value.status === 'paused') {
    expected = [...common, 'reason', ...(value.stateVersion === undefined ? ['workIdentity'] : ['stateVersion'])]
  } else {
    expected = [...common, 'stateVersion', 'pausedObservationId', 'commandId']
  }
  const keys = Object.keys(value).sort()
  if (keys.length !== expected.length || !expected.sort().every((key, index) => key === keys[index])) {
    throw new Error('Governor record has unexpected fields')
  }
  if (Object.hasOwn(value, 'stateVersion') && !/^[0-9a-f]{64}$/.test(value.stateVersion || '')) {
    throw new Error('Governor record stateVersion must be a SHA-256 digest')
  }
  if (Object.keys(value.subject).length !== 2
    || !Object.hasOwn(value.subject, 'type') || !Object.hasOwn(value.subject, 'number')) {
    throw new Error('Governor record subject has unexpected fields')
  }
  if (value.status === 'admitted'
    && (typeof value.candidateObservationId !== 'string' || !value.candidateObservationId.trim()
      || value.candidateObservationId.length > 200
      || value.candidateObservationId === value.observationId)) {
    throw new Error('Governor admission requires an independent candidate observation')
  }
  if (['attempt', 'paused'].includes(value.status) && Object.hasOwn(value, 'workIdentity')
    && (typeof value.workIdentity !== 'string' || !value.workIdentity.trim() || value.workIdentity.length > 300)) {
    throw new Error('Governor budget record requires a bounded work identity')
  }
  if (value.status === 'attempt' && (!Number.isSafeInteger(value.attempt) || value.attempt < 1)) {
    throw new Error('Governor attempt record requires a positive attempt number')
  }
  if (value.status === 'paused'
    && (typeof value.reason !== 'string' || !value.reason.trim() || value.reason.length > 200)) {
    throw new Error('Governor pause record requires a bounded reason')
  }
  if (value.status === 'resumed'
    && (typeof value.pausedObservationId !== 'string' || !value.pausedObservationId.trim()
      || value.pausedObservationId.length > 200
      || typeof value.commandId !== 'string' || !value.commandId.trim() || value.commandId.length > 200)) {
    throw new Error('Governor resume record requires pause and command identifiers')
  }
  return value
}

/** Render one strict GitHub-visible governor state record. */
export function governorRecordBody(record) {
  return `${RECORD_MARKER}${canonicalJson(validatedRecord(record))}${RECORD_TRAILER}`
}

/** Parse one strict GitHub-visible governor state record. */
export function parseGovernorRecord(body) {
  const markerAt = typeof body === 'string' ? body.lastIndexOf(RECORD_MARKER) : -1
  if (markerAt < 0 || markerAt !== body.indexOf(RECORD_MARKER) || !body.endsWith(RECORD_TRAILER)) {
    throw new Error('Governor record must contain exactly one terminal machine record')
  }
  let value
  try {
    value = JSON.parse(body.slice(markerAt + RECORD_MARKER.length, -RECORD_TRAILER.length))
  } catch (error) {
    throw new Error(`Governor record is not valid JSON: ${error.message}`, { cause: error })
  }
  return validatedRecord(value)
}

/** Decide whether one state transition is staged, admitted, or already consumed. */
export function governorDecision({ transition, subject, stateVersion, observationId, records, resumeCondition }) {
  transitionId(transition)
  const currentVersion = subjectStateVersion(subject)
  if (stateVersion !== currentVersion) throw new Error('Governor state version does not match the current subject')
  if (typeof observationId !== 'string' || !observationId.trim() || observationId.length > 200) {
    throw new Error('Governor observationId must be non-empty text of at most 200 characters')
  }
  if (!Array.isArray(records)) throw new Error('Governor records must be an array')
  const epoch = activeGovernorEpoch(records, subject)
  if (epoch.openPause) {
    if (resumeCondition?.authorized === true
      && typeof resumeCondition.commandId === 'string' && resumeCondition.commandId.trim()) {
      return {
        action: 'record-resume',
        execute: false,
        record: {
          version: 1,
          status: 'resumed',
          transition,
          subject: { type: subject.type, number: subject.number },
          stateVersion,
          observationId,
          pausedObservationId: epoch.openPause.observationId,
          commandId: resumeCondition.commandId,
        },
      }
    }
    return { action: 'paused', execute: false, reason: epoch.openPause.reason }
  }
  const matching = epoch.records.filter(record => record?.version === 1
    && record.transition === transition
    && record.stateVersion === stateVersion)
  if (matching.some(record => record.status === 'applied')) {
    return { action: 'noop', execute: false, reason: 'transition-already-applied' }
  }
  if (matching.some(record => record.status === 'admitted')) {
    return { action: 'wait', execute: false, reason: 'transition-already-admitted' }
  }
  const candidate = matching.find(record => record.status === 'candidate')
  if (!candidate) {
    return {
      action: 'record-candidate',
      execute: false,
      record: candidateRecord({ transition, subject, stateVersion, observationId }),
    }
  }
  if (candidate.observationId === observationId) {
    return { action: 'wait', execute: false, reason: 'independent-observation-required' }
  }
  return {
    action: 'admit',
    execute: true,
    record: {
      ...candidateRecord({ transition, subject, stateVersion, observationId }),
      status: 'admitted',
      candidateObservationId: candidate.observationId,
    },
  }
}

/** Consume one independently bounded automatic-transition attempt for a subject work identity. */
export function governorBudgetDecision({ transition, subject, workIdentity, observationId, limit, records }) {
  transitionId(transition)
  if (!SUBJECT_TYPES.has(subject?.type) || !Number.isSafeInteger(subject?.number) || subject.number < 1) {
    throw new Error('Governor budget subject is invalid')
  }
  if (typeof workIdentity !== 'string' || !workIdentity.trim() || workIdentity.length > 300) {
    throw new Error('Governor budget requires a bounded work identity')
  }
  if (typeof observationId !== 'string' || !observationId.trim() || observationId.length > 200) {
    throw new Error('Governor budget observationId is invalid')
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('Governor budget limit must be from 1 to 100')
  if (!Array.isArray(records)) throw new Error('Governor budget records must be an array')
  const attempts = activeGovernorEpoch(records, subject).records.filter(record => record?.version === 1
    && record.status === 'attempt'
    && record.transition === transition
    && record.subject?.type === subject.type
    && record.subject?.number === subject.number
    && record.workIdentity === workIdentity)
  if (attempts.some(record => record.observationId === observationId)) {
    return { action: 'noop', execute: false, reason: 'attempt-already-recorded' }
  }
  const consumed = new Set(attempts.map(record => record.attempt)).size
  if (consumed >= limit) {
    return {
      action: 'pause',
      execute: false,
      record: {
        version: 1,
        status: 'paused',
        transition,
        subject: { type: subject.type, number: subject.number },
        workIdentity,
        observationId,
        reason: 'budget-exhausted',
      },
    }
  }
  return {
    action: 'attempt',
    execute: true,
    record: {
      version: 1,
      status: 'attempt',
      transition,
      subject: { type: subject.type, number: subject.number },
      workIdentity,
      observationId,
      attempt: consumed + 1,
    },
  }
}

/** Return whether a value is one exact Gregorian calendar date in UTC notation. */
export function isUtcDay(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = new Date(`${value}T00:00:00.000Z`)
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
}

/** Select an explicitly promoted stable controller revision or defer one batched rollout. */
export function rolloutDecision({
  stableRevision,
  proposedRevisions,
  activeProductPullRequests,
  faultBound,
  lastPromotionDay,
  promotionDay,
}) {
  if (!FULL_SHA.test(stableRevision || '')
    || !Array.isArray(proposedRevisions) || proposedRevisions.length < 1
    || proposedRevisions.some(revision => !FULL_SHA.test(revision))
    || !Array.isArray(activeProductPullRequests)
    || activeProductPullRequests.some(pullRequest => !Number.isSafeInteger(pullRequest?.number)
      || pullRequest.number < 1 || !['review', 'ci', 'landing'].includes(pullRequest.phase))
    || typeof faultBound !== 'boolean'
    || !isUtcDay(lastPromotionDay)
    || !isUtcDay(promotionDay)) {
    throw new Error('Controller rollout evidence is incomplete')
  }
  const unique = [...new Set(proposedRevisions)].filter(revision => revision !== stableRevision)
  if (unique.length === 0) return { action: 'noop', stableRevision }
  const pendingRevision = unique.at(-1)
  if (!faultBound && activeProductPullRequests.length > 0) {
    return {
      action: 'defer',
      stableRevision,
      pendingRevision,
      supersededRevisions: unique.slice(0, -1),
      reason: 'product-critical-section',
    }
  }
  if (!faultBound && lastPromotionDay === promotionDay) {
    return {
      action: 'defer',
      stableRevision,
      pendingRevision,
      supersededRevisions: unique.slice(0, -1),
      reason: 'daily-promotion-slot-consumed',
    }
  }
  return {
    action: 'promote',
    stableRevision: pendingRevision,
    supersededRevisions: unique.slice(0, -1),
    promotionDay,
  }
}
