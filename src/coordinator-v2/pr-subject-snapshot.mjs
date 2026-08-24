// @ts-check

import { selectExactHeadCi } from './pr-ci-snapshot.mjs'

const SHA_PATTERN = /^[0-9a-f]{40}$/
const REPOSITORY_PATTERN = /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/
const MAX_REF_BYTES = 256
const MAX_LINKED_ISSUES = 8
const INPUT_FIELDS = [
  'ciInput', 'linkedIssueSnapshot', 'pullRequestAfter', 'pullRequestBefore',
  'pullRequestNumber', 'repairSnapshot', 'repository', 'repositorySnapshot',
]
const REPOSITORY_FIELDS = ['defaultBranch', 'repository']
const PULL_REQUEST_FIELDS = [
  'baseBranch', 'baseSha', 'draft', 'headRepository', 'headSha',
  'mergeable', 'number', 'repository', 'state', 'updatedAt',
]
const LINKED_SNAPSHOT_FIELDS = ['complete', 'headSha', 'issues', 'pullRequestNumber', 'repository']
const LINKED_ISSUE_FIELDS = ['number', 'repository', 'state', 'type']
const REPAIR_FIELDS = [
  'active', 'attempts', 'complete', 'headSha', 'limit', 'pullRequestNumber', 'repository',
]
const IDENTITY_FIELDS = [
  'repository', 'number', 'state', 'draft', 'baseBranch', 'baseSha',
  'headRepository', 'headSha', 'updatedAt',
]

/** @typedef {'open' | 'closed'} SubjectState */
/** @typedef {'pull-request-not-open' | 'draft' | 'wrong-target-branch' | 'fork-head' | 'missing-linked-issue' | 'linked-issue-outside-repository' | 'linked-subject-not-issue' | 'linked-issue-not-open'} IneligibleReason */
/** @typedef {{ repository: string, defaultBranch: string }} RepositoryObservation */
/** @typedef {{ repository: string, number: number, state: SubjectState, draft: boolean, baseBranch: string, baseSha: string, headRepository: string, headSha: string, mergeable: boolean | null, updatedAt: string }} PullRequestObservation */
/** @typedef {{ repository: string, number: number, state: SubjectState, type: 'issue' | 'pull-request' }} LinkedIssueObservation */
/** @typedef {{ active: boolean, attempts: number, limit: number }} RepairObservation */
/** @typedef {{ repository: string, pullRequestNumber: number, defaultBranch: string, pullRequest: PullRequestObservation, ci: import('./pr-ci-snapshot.mjs').CiObservation, repair: RepairObservation, linkedIssue: LinkedIssueObservation }} PullRequestSubjectSnapshot */
/** @typedef {{ status: 'ok', snapshot: PullRequestSubjectSnapshot } | { status: 'ineligible', reason: IneligibleReason, repository: string, pullRequestNumber: number } | { status: 'drifted', reason: 'pull-request-changed', changedFields: string[] } | { status: 'invalid', reason: 'invalid-input', detail: string }} PullRequestSubjectResult */

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

/** @param {unknown} value @param {string} name @returns {number} */
function nonNegativeInteger(value, name) {
  if (!Number.isSafeInteger(value) || /** @type {number} */ (value) < 0) {
    throw new Error(`${name} must be a non-negative safe integer`)
  }
  return /** @type {number} */ (value)
}

/** @param {unknown} value @param {string} name @returns {string} */
function repositoryName(value, name) {
  if (typeof value !== 'string' || value !== value.toLowerCase()
    || !REPOSITORY_PATTERN.test(value) || Buffer.byteLength(value, 'utf8') > 200) {
    throw new Error(`${name} must use canonical lowercase owner/name form`)
  }
  return value
}

/** @param {unknown} value @param {string} name @returns {string} */
function fullSha(value, name) {
  if (typeof value !== 'string' || !SHA_PATTERN.test(value)) throw new Error(`${name} must be a full lowercase SHA`)
  return value
}

/** @param {unknown} value @param {string} name @returns {string} */
function timestamp(value, name) {
  if (typeof value !== 'string') throw new Error(`${name} must be a timestamp`)
  const milliseconds = Date.parse(value)
  if (!Number.isFinite(milliseconds)) throw new Error(`${name} must be a timestamp`)
  return new Date(milliseconds).toISOString()
}

/** @param {unknown} value @param {string} name @returns {string} */
function branchName(value, name) {
  if (typeof value !== 'string' || !value || value !== value.trim()
    || Buffer.byteLength(value, 'utf8') > MAX_REF_BYTES
    || /[\u0000-\u0020\u007f~^:?*[\\]/.test(value)
    || value.startsWith('/') || value.endsWith('/') || value.includes('//')
    || value.includes('..') || value.includes('@{')) {
    throw new Error(`${name} must be a bounded canonical branch name`)
  }
  return value
}

/** @param {unknown} value @param {string} name @returns {SubjectState} */
function subjectState(value, name) {
  if (value !== 'open' && value !== 'closed') throw new Error(`${name} must be open or closed`)
  return value
}

/** @param {unknown} value @returns {RepositoryObservation} */
function normalizeRepository(value) {
  const record = exactObject(value, REPOSITORY_FIELDS, 'Repository observation')
  return {
    repository: repositoryName(record.repository, 'Repository observation repository'),
    defaultBranch: branchName(record.defaultBranch, 'Repository default branch'),
  }
}

/** @param {unknown} value @param {string} name @returns {PullRequestObservation} */
function normalizePullRequest(value, name) {
  const record = exactObject(value, PULL_REQUEST_FIELDS, name)
  if (typeof record.draft !== 'boolean') throw new Error(`${name} draft must be boolean`)
  if (record.mergeable !== true && record.mergeable !== false && record.mergeable !== null) {
    throw new Error(`${name} mergeability must be boolean or null`)
  }
  const normalized = {
    repository: repositoryName(record.repository, `${name} repository`),
    number: positiveInteger(record.number, `${name} number`),
    state: subjectState(record.state, `${name} state`),
    draft: record.draft,
    baseBranch: branchName(record.baseBranch, `${name} base branch`),
    baseSha: fullSha(record.baseSha, `${name} base SHA`),
    headRepository: repositoryName(record.headRepository, `${name} head repository`),
    headSha: fullSha(record.headSha, `${name} head SHA`),
    mergeable: record.mergeable,
    updatedAt: timestamp(record.updatedAt, `${name} updatedAt`),
  }
  if (normalized.baseSha === normalized.headSha) throw new Error(`${name} base and head SHAs must differ`)
  return normalized
}

/** @param {unknown} value @param {string} repository @param {number} pullRequestNumber @param {string} headSha @returns {LinkedIssueObservation[]} */
function normalizeLinkedIssues(value, repository, pullRequestNumber, headSha) {
  const snapshot = exactObject(value, LINKED_SNAPSHOT_FIELDS, 'Linked-Issue snapshot')
  if (snapshot.complete !== true) throw new Error('Linked-Issue snapshot is incomplete')
  if (repositoryName(snapshot.repository, 'Linked-Issue snapshot repository') !== repository
    || positiveInteger(snapshot.pullRequestNumber, 'Linked-Issue snapshot pull-request number') !== pullRequestNumber
    || fullSha(snapshot.headSha, 'Linked-Issue snapshot head SHA') !== headSha) {
    throw new Error('Linked-Issue snapshot does not match the pull-request subject')
  }
  if (!Array.isArray(snapshot.issues) || snapshot.issues.length > MAX_LINKED_ISSUES) {
    throw new Error('Linked-Issue snapshot must contain a bounded array')
  }
  /** @type {Map<number, LinkedIssueObservation>} */
  const byNumber = new Map()
  for (const candidate of snapshot.issues) {
    const record = exactObject(candidate, LINKED_ISSUE_FIELDS, 'Linked-Issue observation')
    const type = record.type
    if (type !== 'issue' && type !== 'pull-request') throw new Error('Linked-Issue type must be issue or pull-request')
    /** @type {LinkedIssueObservation} */
    const normalized = {
      repository: repositoryName(record.repository, 'Linked-Issue repository'),
      number: positiveInteger(record.number, 'Linked-Issue number'),
      state: subjectState(record.state, 'Linked-Issue state'),
      type,
    }
    const previous = byNumber.get(normalized.number)
    if (previous && JSON.stringify(previous) !== JSON.stringify(normalized)) {
      throw new Error(`Linked Issue #${normalized.number} has conflicting observations`)
    }
    byNumber.set(normalized.number, normalized)
  }
  return [...byNumber.values()].sort((left, right) => left.number - right.number)
}

/** @param {unknown} value @param {string} repository @param {number} pullRequestNumber @param {string} headSha @returns {RepairObservation} */
function normalizeRepair(value, repository, pullRequestNumber, headSha) {
  if (value === null) return { active: false, attempts: 0, limit: 0 }
  const record = exactObject(value, REPAIR_FIELDS, 'Repair snapshot')
  if (record.complete !== true) throw new Error('Repair snapshot is incomplete')
  if (repositoryName(record.repository, 'Repair snapshot repository') !== repository
    || positiveInteger(record.pullRequestNumber, 'Repair snapshot pull-request number') !== pullRequestNumber
    || fullSha(record.headSha, 'Repair snapshot head SHA') !== headSha) {
    throw new Error('Repair snapshot does not match the pull-request subject')
  }
  if (typeof record.active !== 'boolean') throw new Error('Repair active must be boolean')
  return {
    active: record.active,
    attempts: nonNegativeInteger(record.attempts, 'Repair attempts'),
    limit: nonNegativeInteger(record.limit, 'Repair limit'),
  }
}

/** @param {PullRequestObservation} before @param {PullRequestObservation} after @returns {string[]} */
function changedIdentityFields(before, after) {
  return IDENTITY_FIELDS.filter(field => before[/** @type {keyof PullRequestObservation} */ (field)]
    !== after[/** @type {keyof PullRequestObservation} */ (field)])
}

/** @param {IneligibleReason} reason @param {string} repository @param {number} pullRequestNumber @returns {PullRequestSubjectResult} */
function ineligible(reason, repository, pullRequestNumber) {
  return { status: 'ineligible', reason, repository, pullRequestNumber }
}

/**
 * Normalize one coherent read-only pull-request subject snapshot.
 * @param {unknown} input
 * @returns {PullRequestSubjectResult}
 */
export function normalizePullRequestSubjectSnapshot(input) {
  try {
    const root = exactObject(input, INPUT_FIELDS, 'Pull-request subject input')
    const repository = repositoryName(root.repository, 'Target repository')
    const pullRequestNumber = positiveInteger(root.pullRequestNumber, 'Pull-request number')
    const repositorySnapshot = normalizeRepository(root.repositorySnapshot)
    const before = normalizePullRequest(root.pullRequestBefore, 'Initial pull-request observation')
    const after = normalizePullRequest(root.pullRequestAfter, 'Final pull-request observation')

    if (repositorySnapshot.repository !== repository
      || before.repository !== repository || after.repository !== repository
      || before.number !== pullRequestNumber || after.number !== pullRequestNumber) {
      throw new Error('Pull-request subject does not match the requested repository and number')
    }

    const changedFields = changedIdentityFields(before, after)
    if (changedFields.length > 0) return { status: 'drifted', reason: 'pull-request-changed', changedFields }

    const ciResult = selectExactHeadCi(root.ciInput)
    if (ciResult.status !== 'ok') throw new Error(`Exact-head CI evidence is invalid: ${ciResult.detail}`)
    if (ciResult.ci.headSha !== after.headSha) throw new Error('Exact-head CI evidence does not match the pull-request head')

    const linkedIssues = normalizeLinkedIssues(root.linkedIssueSnapshot, repository, pullRequestNumber, after.headSha)
    const repair = normalizeRepair(root.repairSnapshot, repository, pullRequestNumber, after.headSha)

    if (after.state !== 'open') return ineligible('pull-request-not-open', repository, pullRequestNumber)
    if (after.draft) return ineligible('draft', repository, pullRequestNumber)
    if (after.baseBranch !== repositorySnapshot.defaultBranch) return ineligible('wrong-target-branch', repository, pullRequestNumber)
    if (after.headRepository !== repository) return ineligible('fork-head', repository, pullRequestNumber)
    if (linkedIssues.length === 0) return ineligible('missing-linked-issue', repository, pullRequestNumber)
    if (linkedIssues.length !== 1) throw new Error('Pull request must link exactly one task Issue')
    const linkedIssue = linkedIssues[0]
    if (!linkedIssue) throw new Error('Pull request task Issue is missing')
    if (linkedIssue.repository !== repository) return ineligible('linked-issue-outside-repository', repository, pullRequestNumber)
    if (linkedIssue.type !== 'issue') return ineligible('linked-subject-not-issue', repository, pullRequestNumber)
    if (linkedIssue.state !== 'open') return ineligible('linked-issue-not-open', repository, pullRequestNumber)

    return {
      status: 'ok',
      snapshot: {
        repository,
        pullRequestNumber,
        defaultBranch: repositorySnapshot.defaultBranch,
        pullRequest: after,
        ci: ciResult.ci,
        repair,
        linkedIssue,
      },
    }
  } catch (error) {
    return {
      status: 'invalid',
      reason: 'invalid-input',
      detail: error instanceof Error ? error.message : String(error),
    }
  }
}
