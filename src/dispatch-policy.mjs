import { declaredIssueBranch, trustedAssociation } from './common.mjs'
import { agentWorkRequestId, parseAgentWork } from './agent-work.mjs'
import { baselineIssueWorkItem } from './baseline-issue.mjs'
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
  return /^\s*(?:@dsh\s+(?:fix|repair|rework|revise|address)\b|dsh:\s*(?:fix|repair|rework|revise|address)\b)/i
    .test(String(body || ''))
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

/** Return whether a completed workflow run is the exact failed CI evidence for a PR head. */
export function trustedCiFailure({ run, pullRequestNumber, expectedHead, workflowName }) {
  return typeof workflowName === 'string'
    && workflowName.length > 0
    && run?.name === workflowName
    && run.event === 'pull_request'
    && run.status === 'completed'
    && run.conclusion === 'failure'
    && run.head_sha === expectedHead
    && run.pull_requests?.some(pullRequest => pullRequest.number === pullRequestNumber)
}

/** Return whether a failed review CheckRun authorizes a repair for its exact PR pair. */
export function trustedBlockedReviewProof({ pullRequest, reviewProof, trustedReview }) {
  return hasTrustedExactReviewRun({ pullRequest, reviewProof, trustedReview })
    && ['FAILURE', 'failure'].includes(reviewProof.checkRun.conclusion)
    && reviewProof.run.conclusion === 'failure'
}

function hasDeclaredBranch(body) {
  return Boolean(declaredIssueBranch(body))
}

function actionableIssue(issue) {
  return hasDeclaredBranch(issue.body)
    || /^\[BUG\]\s+/i.test(issue.title || '')
    || Boolean(baselineIssueWorkItem(issue))
}

function issueDispatch(issue) {
  const work = parseAgentWork(issue.body)
  if (work) {
    if (work.dispatch !== 'ready') return null
    return {
      dependencies: work.dependsOn,
      selected: {
        type: 'issue',
        number: issue.number,
        role: work.role,
        requestId: agentWorkRequestId(work),
      },
    }
  }
  return actionableIssue(issue)
    ? { dependencies: issueDependencies(issue.body), selected: { type: 'issue', number: issue.number } }
    : null
}

function closesIssue(pullRequest, issueNumber) {
  return new RegExp(`\\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\\s+#${issueNumber}\\b`, 'i')
    .test(pullRequest.body || '')
}

/** Select one safe unit of backlog work, preferring blocked PR repairs. */
export function selectBacklogWork({ repository, pullRequests, issues, trustedBlockedRepairNumbers = new Set() }) {
  const repair = [...pullRequests]
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
    .filter(candidate => candidate.state === 'open' && trustedAssociation(candidate.author_association))
    .sort((left, right) => left.number - right.number)
  for (const candidate of candidates) {
    if (labelNames(candidate).has('agent/dsh-failed')
      || labelNames(candidate).has('agent/dsh-blocked')
      || pullRequests.some(pullRequest => closesIssue(pullRequest, candidate.number))) continue
    const dispatch = issueDispatch(candidate)
    if (dispatch && dispatch.dependencies.every(number => !openIssueNumbers.has(number))) {
      return dispatch.selected
    }
  }
  return null
}
