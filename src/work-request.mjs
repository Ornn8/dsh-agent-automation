const FULL_SHA = /^[0-9a-f]{40}$/
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const ROLES = new Set(['change', 'review'])
const KINDS = new Set(['issue-implementation', 'review-repair', 'ci-repair', 'review'])

function requiredText(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} must be a non-empty string`)
  return value.trim()
}

/** Return the safe, durable request id for one exact blocked review pair. */
export function reviewRepairRequestId(base, head) {
  if (!FULL_SHA.test(base) || !FULL_SHA.test(head)) {
    throw new Error('review repair request id requires full lowercase commit SHAs')
  }
  return `review-repair-${base}-${head}`
}

/** Return whether a request id binds the supplied exact review head. */
export function isReviewRepairRequestId(value, expectedHead) {
  const match = /^review-repair-([0-9a-f]{40})-([0-9a-f]{40})$/.exec(String(value || ''))
  return Boolean(match && FULL_SHA.test(expectedHead) && match[2] === expectedHead)
}

/** Validate and return one immutable agent work request. */
export function parseAgentWorkRequest(value) {
  if (!value || value.version !== 1) throw new Error('work request version must be 1')
  const requestId = requiredText(value.requestId, 'work request requestId')
  const role = requiredText(value.role, 'work request role')
  const kind = requiredText(value.kind, 'work request kind')
  const repository = requiredText(value.repository, 'work request repository')
  if (!ROLES.has(role)) throw new Error(`Unknown work request role ${role}`)
  if (!KINDS.has(kind)) throw new Error(`Unknown work request kind ${kind}`)
  if (!REPOSITORY.test(repository)) throw new Error('work request repository is invalid')
  if (!['issue', 'pull-request'].includes(value.subject?.type)
    || !Number.isSafeInteger(value.subject.number)
    || value.subject.number < 1) {
    throw new Error('work request subject must identify an issue or pull request')
  }
  const expectedSubject = kind === 'issue-implementation' ? 'issue' : 'pull-request'
  if (value.subject.type !== expectedSubject) throw new Error(`work request kind ${kind} requires a ${expectedSubject} subject`)
  if (!FULL_SHA.test(value.revision?.base) || !FULL_SHA.test(value.revision?.head)) {
    throw new Error('work request revision must contain full lowercase commit SHAs')
  }
  return {
    version: 1,
    requestId,
    role,
    kind,
    repository,
    subject: { type: value.subject.type, number: value.subject.number },
    revision: { base: value.revision.base, head: value.revision.head },
  }
}

/** Create the durable change-role request for an eligible Issue. */
export function createIssueImplementationRequest({ repository, issueNumber, base }) {
  return parseAgentWorkRequest({
    version: 1,
    requestId: `issue-implementation:${issueNumber}:${base}`,
    role: 'change',
    kind: 'issue-implementation',
    repository,
    subject: { type: 'issue', number: issueNumber },
    revision: { base, head: base },
  })
}

/** Create the durable change-role request produced by a blocking exact-pair review. */
export function createReviewRepairRequest({ repository, pullRequestNumber, base, head }) {
  return parseAgentWorkRequest({
    version: 1,
    requestId: reviewRepairRequestId(base, head),
    role: 'change',
    kind: 'review-repair',
    repository,
    subject: { type: 'pull-request', number: pullRequestNumber },
    revision: { base, head },
  })
}

/** Wrap a validated work request for GitHub repository_dispatch transport. */
export function repositoryDispatchBody(request) {
  return {
    event_type: 'agent_work_requested',
    client_payload: parseAgentWorkRequest(request),
  }
}
