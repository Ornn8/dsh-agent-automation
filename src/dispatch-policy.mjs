import { trustedAssociation } from './common.mjs'
import { parseAgentWork } from './agent-work.mjs'
import { hasTrustedExactReviewRun } from './landing-policy.mjs'

function labelNames(item) {
  return new Set((item.labels || []).map(label => typeof label === 'string' ? label : label.name))
}

/** Return Issue numbers that the body explicitly declares as blockers. */
export function issueDependencies(body) {
  const dependencies = []
  const pattern = /\b(?:depends on|blocked by)\s+#(\d+)\b/gi
  for (const match of String(body || '').matchAll(pattern)) dependencies.push(Number(match[1]))
  return [...new Set(dependencies)]
}

/** Return whether a trusted PR comment explicitly requests a DSH repair. */
export function explicitReworkCommand(body) {
  return /^\s*(?:@(?:dsh|agent)\s+(?:fix|repair|rework|revise|address)\b|(?:dsh|agent):\s*(?:fix|repair|rework|revise|address)\b|\/automation\s+(?:repair|rework)\b)/i
    .test(String(body || ''))
}

/** Return whether a trusted comment explicitly resumes terminal paused automation. */
export function explicitResumeCommand(body) {
  return /^\s*\/automation\s+resume\s*$/i.test(String(body || ''))
}

/** Parse an idempotent CI repair request from a completed workflow run. */
export function ciRepairRequest(value) {
  const run = /^ci-run-(\d+)-(\d+)(?:\.recovery-\d+)?$/.exec(String(value || ''))
  if (run) {
    const runId = Number.parseInt(run[1], 10)
    const attempt = Number.parseInt(run[2], 10)
    return Number.isSafeInteger(runId) && runId > 0 && Number.isSafeInteger(attempt) && attempt > 0
      ? { kind: 'run', runId, attempt }
      : null
  }
  return null
}

/** Return the distinct Governor transition for one failed CI workflow run. */
export function ciRepairTransition(runId) {
  if (!Number.isSafeInteger(runId) || runId < 1) {
    throw new Error('CI repair transition requires a positive workflow run id')
  }
  return `ci-repair:run-${runId}`
}

/** Return whether a completed workflow run is exact failed CI evidence for a commit head. */
export function trustedCiFailure({ run, pullRequestNumber, expectedHead, workflowName }) {
  return typeof workflowName === 'string'
    && workflowName.length > 0
    && run?.name === workflowName
    && run.status === 'completed'
    && run.conclusion === 'failure'
    && run.head_sha === expectedHead
    && (!Array.isArray(run.pull_requests)
      || run.pull_requests.length === 0
      || run.pull_requests.some(pullRequest => pullRequest.number === pullRequestNumber))
}

/** Return whether the same exact-head CI run succeeded on a later attempt. */
export function trustedCiRerunSuccess({ priorRun, currentRun, pullRequestNumber, expectedHead, workflowName }) {
  return Number.isSafeInteger(priorRun?.id)
    && priorRun.id > 0
    && currentRun?.id === priorRun.id
    && Number.isSafeInteger(priorRun.run_attempt)
    && Number.isSafeInteger(currentRun.run_attempt)
    && currentRun.run_attempt > priorRun.run_attempt
    && typeof workflowName === 'string'
    && workflowName.length > 0
    && currentRun.name === workflowName
    && currentRun.status === 'completed'
    && currentRun.conclusion === 'success'
    && currentRun.head_sha === expectedHead
    && (!Array.isArray(currentRun.pull_requests)
      || currentRun.pull_requests.length === 0
      || currentRun.pull_requests.some(pullRequest => pullRequest.number === pullRequestNumber))
}

/** Return whether a failed review CheckRun authorizes a repair for its exact PR pair. */
export function trustedBlockedReviewProof({ pullRequest, reviewProof, trustedReview }) {
  return hasTrustedExactReviewRun({ pullRequest, reviewProof, trustedReview })
    && ['FAILURE', 'failure'].includes(reviewProof.checkRun.conclusion)
    && reviewProof.run.conclusion === 'failure'
}

function issueDispatch(issue) {
  const work = parseAgentWork(issue.body)
  if (!work || work.dispatch !== 'ready') return null
  return {
    dependencies: work.dependsOn,
    selected: { type: 'issue', number: issue.number, work },
  }
}

function closesIssue(pullRequest, issueNumber) {
  return new RegExp(`\\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\\s+#${issueNumber}\\b`, 'i')
    .test(pullRequest.body || '')
}

/** Return active Issue numbers for one Profile workflow coordination key. */
export function activeWorkflowIssueNumbers({ issues, pullRequests, profileId, workflowId, excludeIssueNumber = null }) {
  const active = new Set()
  for (const issue of issues) {
    if (issue.state !== 'open') continue
    if (issue.number === excludeIssueNumber) continue
    let declaration
    try {
      declaration = parseAgentWork(issue.body)
    } catch {
      // A malformed declaration cannot be admitted, so it cannot own workflow capacity.
      continue
    }
    if (!declaration || declaration.profile !== profileId || declaration.workflow !== workflowId) continue
    const owned = labelNames(issue).has('agent/dsh')
    const hasPullRequest = pullRequests.some(pullRequest => closesIssue(pullRequest, issue.number))
    if (owned || hasPullRequest) active.add(issue.number)
  }
  return active
}

/** Return the Issue that needs a later independent Governor observation. */
export function independentIssueObservationNumber({ work, governorAction }) {
  return work?.type === 'issue' && governorAction === 'record-candidate'
    ? work.number
    : null
}

/** Select one exact, still-open capacity-waiting subject for a later bounded resume. */
export function selectCapacityWaitingWork({ pullRequests = [], issues = [], capacityWaits = [] } = {}) {
  const pullRequestByNumber = new Map(pullRequests.map(value => [value.number, value]))
  const issueByNumber = new Map(issues.map(value => [value.number, value]))
  const candidates = capacityWaits
    .filter(wait => wait?.projection?.role === 'change'
      && wait.currentStateVersion === wait.projection.subject.stateVersion)
    .map(wait => {
      const projection = wait.projection
      const source = projection.subject.type === 'pull-request'
        ? pullRequestByNumber.get(projection.subject.number)
        : issueByNumber.get(projection.subject.number)
      if (!source || source.state !== 'open') return null
      if (projection.subject.type === 'pull-request') {
        if (source.draft || source.head?.repo?.full_name !== wait.repository
          || source.base?.sha !== projection.subject.base
          || source.head?.sha !== projection.subject.head
          || labelNames(source).has('automation/paused')
          || labelNames(source).has('automation/repairing')
          || labelNames(source).has('automation/repair-blocked')
          || labelNames(source).has('automation/ci-baseline')
          || labelNames(source).has('agent/dsh-failed')) return null
        return { type: 'repair', number: source.number, head: source.head.sha, projection }
      }
      if (labelNames(source).has('automation/paused')
        || labelNames(source).has('agent/dsh-failed')
        || labelNames(source).has('agent/dsh-blocked')
        || pullRequests.some(pullRequest => closesIssue(pullRequest, source.number))) return null
      return { type: 'issue', number: source.number, projection }
    })
    .filter(Boolean)
    .sort((left, right) => left.number - right.number)
  return candidates[0] || null
}

/** Select one safe unit of backlog work, preferring blocked PR repairs. */
export function selectBacklogWork({
  repository,
  pullRequests,
  issues,
  trustedBlockedRepairNumbers = new Set(),
  includeRepairs = true,
  requestedIssueNumber = null,
}) {
  if (requestedIssueNumber !== null
    && (!Number.isSafeInteger(requestedIssueNumber) || requestedIssueNumber < 1)) {
    throw new Error('requestedIssueNumber must be null or a positive safe integer')
  }
  const repair = requestedIssueNumber === null && includeRepairs && [...pullRequests]
    .filter(pullRequest => !pullRequest.draft
      && pullRequest.head?.repo?.full_name === repository
      && labelNames(pullRequest).has('automation/review-blocked')
      && trustedBlockedRepairNumbers.has(pullRequest.number)
      && !labelNames(pullRequest).has('automation/repairing')
      && !labelNames(pullRequest).has('automation/repair-blocked')
      && !labelNames(pullRequest).has('automation/ci-baseline')
      && !labelNames(pullRequest).has('agent/dsh-failed'))
    .sort((left, right) => left.number - right.number)[0]
  if (repair) return { type: 'repair', number: repair.number, head: repair.head.sha }

  const openIssueNumbers = new Set(issues
    .filter(issue => issue.state === 'open')
    .map(issue => issue.number))
  const candidates = [...issues]
    .filter(candidate => candidate.state === 'open'
      && trustedAssociation(candidate.author_association)
      && (requestedIssueNumber === null || candidate.number === requestedIssueNumber))
    .sort((left, right) => left.number - right.number)
  for (const candidate of candidates) {
    if (labelNames(candidate).has('agent/dsh-failed')
      || labelNames(candidate).has('agent/dsh-blocked')
      || (labelNames(candidate).has('agent/dsh') && candidate.number !== requestedIssueNumber)
      || labelNames(candidate).has('automation/paused')
      || pullRequests.some(pullRequest => closesIssue(pullRequest, candidate.number))) continue
    const dispatch = issueDispatch(candidate)
    if (dispatch && dispatch.dependencies.every(number => !openIssueNumbers.has(number))) {
      return dispatch.selected
    }
  }
  return null
}
