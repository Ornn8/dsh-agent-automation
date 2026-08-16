const GITHUB_ACTIONS_APP_ID = 15368

function checkName(check) {
  return check.__typename === 'StatusContext' ? check.context : check.name
}

function checkPassed(check) {
  if (check.__typename === 'StatusContext') return check.state === 'SUCCESS'
  return ['COMPLETED', 'completed'].includes(check.status)
    && ['SUCCESS', 'SKIPPED', 'NEUTRAL', 'success', 'skipped', 'neutral'].includes(check.conclusion)
}

function requiredCheckName(required) {
  return typeof required === 'string' ? required : required?.context
}

function latestRequiredCheck(checkRuns, required) {
  const name = requiredCheckName(required)
  const appId = typeof required === 'object' ? required?.app_id : null
  return checkRuns
    .filter(check => checkName(check) === name
      && (appId === null || appId === undefined || check.app?.id === appId))
    .sort((left, right) => (right.id || 0) - (left.id || 0))[0]
}

/** Return the Actions run id only for a check URL belonging to this repository. */
export function reviewRunIdFromDetailsUrl(value, repository) {
  if (typeof value !== 'string' || typeof repository !== 'string') return null
  const match = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/actions\/runs\/(\d+)(?:\/|$)/.exec(value)
  if (!match || match[1] !== repository) return null
  const runId = Number.parseInt(match[2], 10)
  return Number.isSafeInteger(runId) && runId > 0 ? runId : null
}

/** Return the trusted workflow candidate encoded by a controller-created CheckRun. */
export function reviewRunIdFromCheckRun(checkRun, repository) {
  return reviewRunIdFromDetailsUrl(checkRun?.external_id, repository)
    || reviewRunIdFromDetailsUrl(checkRun?.details_url, repository)
}

function hasExactPullRequest(run, pullRequest, repository) {
  if (run?.repository?.full_name !== repository
    || run.head_repository?.full_name !== repository
    || run.status !== 'completed'
    || !run.head_sha) return false
  if (run.event === 'repository_dispatch') {
    return run.head_sha === pullRequest.baseRefOid
      && typeof pullRequest.baseRefName === 'string'
      && pullRequest.baseRefName.length > 0
      && run.head_branch === pullRequest.baseRefName
  }
  return run.event === 'pull_request_target'
    && run.head_sha === pullRequest.headRefOid
    && run.pull_requests?.some(candidate => candidate.number === pullRequest.number
      && candidate.base?.sha === pullRequest.baseRefOid
      && candidate.head?.sha === pullRequest.headRefOid)
}

function referencesTrustedController(run, trustedReview) {
  const expectedPath = `${trustedReview.controllerRepository}/${trustedReview.workflowPath}@${trustedReview.controllerSha}`
  return run?.referenced_workflows?.some(reference => reference.path === expectedPath
    && reference.sha === trustedReview.controllerSha)
}

/** Verify a completed review CheckRun against its immutable reusable-workflow provenance. */
export function hasTrustedExactReviewRun({ pullRequest, reviewProof, trustedReview }) {
  const checkRun = reviewProof?.checkRun
  const run = reviewProof?.run
  if (!checkRun || !run || !trustedReview) return false
  return checkRun.name === 'agent/review'
    && ['COMPLETED', 'completed'].includes(checkRun.status)
    && checkRun.app?.id === GITHUB_ACTIONS_APP_ID
    && reviewRunIdFromCheckRun(checkRun, pullRequest.repository) === run.id
    && hasExactPullRequest(run, pullRequest, pullRequest.repository)
    && referencesTrustedController(run, trustedReview)
}

/** Verify a successful exact-pair review against immutable Actions provenance. */
export function hasTrustedExactReviewProof({ pullRequest, reviewProof, trustedReview }) {
  return hasTrustedExactReviewRun({ pullRequest, reviewProof, trustedReview })
    && ['SUCCESS', 'success'].includes(reviewProof.checkRun.conclusion)
    && reviewProof.run.conclusion === 'success'
}

/** Decide whether a pull request is ready for the privileged landing operation. */
export function evaluateLanding({ pullRequest, expectedHead, requiredChecks, checkRuns = [], reviewProof, trustedReview }) {
  if (pullRequest.state !== 'OPEN' || pullRequest.isDraft) {
    return { ready: false, reason: 'pull request is not open and ready' }
  }
  if (pullRequest.headRefOid !== expectedHead) {
    return { ready: false, reason: 'pull request head changed' }
  }
  if (pullRequest.mergeStateStatus !== 'CLEAN') {
    return { ready: false, reason: `merge state is ${pullRequest.mergeStateStatus}` }
  }
  if (!hasTrustedExactReviewProof({ pullRequest, reviewProof, trustedReview })) {
    return { ready: false, reason: 'no trusted exact-pair Codex PASS exists' }
  }
  for (const required of requiredChecks) {
    const latest = latestRequiredCheck(checkRuns, required)
    if (!latest || !checkPassed(latest)) {
      return { ready: false, reason: `required check ${requiredCheckName(required)} has not passed` }
    }
  }
  return { ready: true, reason: 'exact review and required checks passed' }
}
