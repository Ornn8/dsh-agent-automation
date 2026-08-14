import {
  actionsCredentialEnvironment,
  parseJson,
  requiredEnv,
  run,
} from './common.mjs'
import { needsDefaultBranchUpdate, needsExactReview } from './reconciliation-policy.mjs'
import { hasTrustedExactReviewRun, reviewRunIdFromDetailsUrl } from './landing-policy.mjs'

const repository = requiredEnv('TARGET_REPOSITORY')
const defaultBranch = requiredEnv('DEFAULT_BRANCH')
const githubExecutable = process.env.GH_EXECUTABLE?.trim() || 'gh'
const githubEnvironment = actionsCredentialEnvironment()
const trustedReview = {
  controllerRepository: requiredEnv('TRUSTED_CONTROLLER_REPOSITORY'),
  controllerSha: requiredEnv('TRUSTED_CONTROLLER_SHA'),
  workflowPath: requiredEnv('TRUSTED_REVIEW_WORKFLOW_PATH'),
}
if (!/^[0-9a-f]{40}$/i.test(trustedReview.controllerSha)) throw new Error('TRUSTED_CONTROLLER_SHA must be a full commit SHA')
const updatePollAttempts = 10
const updatePollDelayMs = 1_000

async function ghJson(args, description) {
  const result = await run(githubExecutable, args, { env: githubEnvironment })
  return parseJson(result.stdout, description)
}

const summaries = await ghJson([
  'api', `repos/${repository}/pulls?state=open&per_page=100`, '--paginate', '--slurp',
], 'open pull requests')
const defaultBranchReference = await ghJson([
  'api', `repos/${repository}/git/ref/heads/${encodeURIComponent(defaultBranch)}`,
], `default branch ${defaultBranch}`)
const defaultBranchHead = defaultBranchReference?.object?.sha
if (!/^[0-9a-f]{40}$/i.test(defaultBranchHead || '')) {
  throw new Error(`Default branch ${defaultBranch} did not resolve to a commit SHA`)
}

async function requestReview(pullRequest) {
  for (const label of ['automation/ci-baseline', 'automation/repair-blocked']) {
    if (!pullRequest.labels?.some(candidate => candidate.name === label)) continue
    await run(githubExecutable, [
      'pr', 'edit', String(pullRequest.number), '--repo', repository,
      '--remove-label', label,
    ], { env: githubEnvironment })
  }
  await run(githubExecutable, [
    'label', 'create', 'automation/review-ready', '--repo', repository,
    '--description', 'Request one exact-pair Codex review', '--color', '0E8A16',
  ], { env: githubEnvironment }).catch(() => undefined)
  await run(githubExecutable, [
    'pr', 'edit', String(pullRequest.number), '--repo', repository,
    '--add-label', 'automation/review-ready',
  ], { env: githubEnvironment })
  await run(githubExecutable, [
    'api', '--method', 'POST', `repos/${repository}/dispatches`,
    '-f', 'event_type=codex-review',
    '-F', `client_payload[pull_request_number]=${pullRequest.number}`,
    '-f', `client_payload[base_sha]=${pullRequest.base.sha}`,
    '-f', `client_payload[head_sha]=${pullRequest.head.sha}`,
    '-f', `client_payload[request_id]=reconcile-${pullRequest.base.sha}-${pullRequest.head.sha}`,
  ], { env: githubEnvironment })
}

async function waitForUpdatedPair(pullRequest) {
  for (let attempt = 1; attempt <= updatePollAttempts; attempt += 1) {
    const current = await ghJson([
      'api', `repos/${repository}/pulls/${pullRequest.number}`,
    ], `updated pull request #${pullRequest.number}`)
    if (current.state !== 'open'
      || current.draft
      || current.base?.ref !== defaultBranch
      || current.head?.repo?.full_name !== repository) {
      throw new Error(`Pull request #${pullRequest.number} changed while updating its base`)
    }
    if (current.base.sha === defaultBranchHead && current.head.sha !== pullRequest.head.sha) return current
    if (attempt < updatePollAttempts) {
      await new Promise(resolvePromise => setTimeout(resolvePromise, updatePollDelayMs))
    }
  }
  throw new Error(`Pull request #${pullRequest.number} did not expose its updated exact pair`)
}

let dispatched = 0
for (const summary of summaries.flat()) {
  const pullRequest = await ghJson([
    'api', `repos/${repository}/pulls/${summary.number}`,
  ], `pull request #${summary.number}`)
  if (pullRequest.draft
    || pullRequest.base?.ref !== defaultBranch
    || pullRequest.head?.repo?.full_name !== repository) continue
  if (needsDefaultBranchUpdate({ defaultBranch, defaultBranchHead, pullRequest })) {
    await run(githubExecutable, [
      'api', '--method', 'PUT', `repos/${repository}/pulls/${pullRequest.number}/update-branch`,
      '-f', `expected_head_sha=${pullRequest.head.sha}`,
    ], { env: githubEnvironment })
    const updatedPullRequest = await waitForUpdatedPair(pullRequest)
    await requestReview(updatedPullRequest)
    dispatched += 1
    process.stdout.write(`Updated pull request #${pullRequest.number} from ${defaultBranch} and dispatched its new exact pair.\n`)
    continue
  }
  const landingPullRequest = {
    number: pullRequest.number, repository, state: pullRequest.state.toUpperCase(), isDraft: pullRequest.draft,
    baseRefName: pullRequest.base.ref,
    baseRefOid: pullRequest.base.sha, headRefOid: pullRequest.head.sha, mergeStateStatus: 'CLEAN',
  }
  const checkRunPages = await ghJson([
    'api', `repos/${repository}/commits/${pullRequest.head.sha}/check-runs`, '--paginate', '--slurp',
  ], `pull request #${summary.number} check runs`)
  const checkRuns = checkRunPages.flatMap(page => page.check_runs || [])
  let reviewProof = null
  for (const checkRun of checkRuns) {
    const runId = reviewRunIdFromDetailsUrl(checkRun.details_url, repository)
    if (!runId || checkRun.name !== 'codex/review') continue
    const workflowRun = await ghJson(['api', `repos/${repository}/actions/runs/${runId}`], `review workflow run ${runId}`)
    const proof = { checkRun, run: workflowRun }
    if (hasTrustedExactReviewRun({ pullRequest: landingPullRequest, reviewProof: proof, trustedReview })) {
      const passed = ['SUCCESS', 'success'].includes(checkRun.conclusion)
        && workflowRun.conclusion === 'success'
      const blocked = ['FAILURE', 'failure'].includes(checkRun.conclusion)
        && workflowRun.conclusion === 'failure'
        && pullRequest.labels?.some(label => label.name === 'automation/review-blocked')
      if (!passed && !blocked) continue
      reviewProof = { base: pullRequest.base.sha, head: pullRequest.head.sha, state: passed ? 'pass' : 'block' }
      break
    }
  }
  if (!needsExactReview({ repository, defaultBranch, pullRequest, reviewProof })) continue

  await requestReview(pullRequest)
  dispatched += 1
}
process.stdout.write(`Dispatched ${dispatched} exact-pair review reconciliation request(s).\n`)
