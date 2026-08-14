const FULL_SHA = /^[0-9a-f]{40}$/
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const ROLES = new Set(['change', 'review'])
const KINDS = new Set(['issue-implementation', 'review-repair', 'ci-repair', 'review'])

function requiredText(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} must be a non-empty string`)
  return value.trim()
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
  if (value.subject?.type !== 'pull-request'
    || !Number.isSafeInteger(value.subject.number)
    || value.subject.number < 1) {
    throw new Error('work request subject must identify a pull request')
  }
  if (!FULL_SHA.test(value.revision?.base) || !FULL_SHA.test(value.revision?.head)) {
    throw new Error('work request revision must contain full lowercase commit SHAs')
  }
  return {
    version: 1,
    requestId,
    role,
    kind,
    repository,
    subject: { type: 'pull-request', number: value.subject.number },
    revision: { base: value.revision.base, head: value.revision.head },
  }
}

/** Create the durable change-role request produced by a blocking exact-pair review. */
export function createReviewRepairRequest({ repository, pullRequestNumber, base, head }) {
  return parseAgentWorkRequest({
    version: 1,
    requestId: `review-repair:${base}:${head}`,
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
