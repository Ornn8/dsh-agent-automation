import { trustedAssociation } from './common.mjs'

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
  return /^\s*(?:@dsh\s+(?:fix|repair|rework|revise|address)\b|dsh:\s*(?:fix|repair|rework|revise|address)\b)/i
    .test(String(body || ''))
}

/** Return whether trusted GitHub review feedback should wake a repair session. */
export function trustedReviewFeedback({ kind, association, state }) {
  if (!trustedAssociation(association)) return false
  if (kind === 'review-comment') return true
  return kind === 'review' && state === 'CHANGES_REQUESTED'
}

/** Parse an idempotent CI repair request from a workflow run or bootstrap head. */
export function ciRepairRequest(value) {
  const run = /^ci-run-(\d+)-(\d+)$/.exec(String(value || ''))
  if (run) {
    const runId = Number.parseInt(run[1], 10)
    const attempt = Number.parseInt(run[2], 10)
    return Number.isSafeInteger(runId) && runId > 0 && Number.isSafeInteger(attempt) && attempt > 0
      ? { kind: 'run', runId, attempt }
      : null
  }
  const head = /^ci-head-([0-9a-f]{40})$/.exec(String(value || ''))
  return head ? { kind: 'head', head: head[1] } : null
}

/** Return whether a completed workflow run is the exact failed CI evidence for a PR head. */
export function trustedCiFailure({ run, pullRequestNumber, expectedHead }) {
  return run?.name === 'CI'
    && run.event === 'pull_request'
    && run.status === 'completed'
    && run.conclusion === 'failure'
    && run.head_sha === expectedHead
    && run.pull_requests?.some(pullRequest => pullRequest.number === pullRequestNumber)
}

function hasDeclaredBranch(body) {
  return /^\s*(?:[-*]\s*)?(?:branch|branch name)\s*:\s*`[^`]+`\s*$/im.test(String(body || ''))
}

function actionableIssue(issue) {
  return hasDeclaredBranch(issue.body) || /^\[BUG\]\s+/i.test(issue.title || '')
}

function closesIssue(pullRequest, issueNumber) {
  return new RegExp(`\\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\\s+#${issueNumber}\\b`, 'i')
    .test(pullRequest.body || '')
}

/** Select one safe unit of backlog work, preferring blocked PR repairs. */
export function selectBacklogWork({ repository, pullRequests, issues }) {
  const repair = [...pullRequests]
    .filter(pullRequest => !pullRequest.draft
      && pullRequest.head?.repo?.full_name === repository
      && labelNames(pullRequest).has('automation/review-blocked')
      && !labelNames(pullRequest).has('automation/repairing')
      && !labelNames(pullRequest).has('agent/dsh-failed'))
    .sort((left, right) => left.number - right.number)[0]
  if (repair) return { type: 'repair', number: repair.number, head: repair.head.sha }

  const openIssueNumbers = new Set(issues
    .filter(issue => issue.state === 'open')
    .map(issue => issue.number))
  const issue = [...issues]
    .filter(candidate => candidate.state === 'open'
      && trustedAssociation(candidate.author_association)
      && actionableIssue(candidate)
      && !labelNames(candidate).has('agent/dsh')
      && !labelNames(candidate).has('agent/dsh-failed')
      && issueDependencies(candidate.body).every(number => !openIssueNumbers.has(number))
      && !pullRequests.some(pullRequest => closesIssue(pullRequest, candidate.number)))
    .sort((left, right) => left.number - right.number)[0]
  return issue ? { type: 'issue', number: issue.number } : null
}
