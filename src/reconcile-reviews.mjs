import {
  actionsCredentialEnvironment,
  parseJson,
  requiredEnv,
  run,
} from './common.mjs'
import { needsExactReview } from './reconciliation-policy.mjs'
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

async function ghJson(args, description) {
  const result = await run(githubExecutable, args, { env: githubEnvironment })
  return parseJson(result.stdout, description)
}

const summaries = await ghJson([
  'api', `repos/${repository}/pulls?state=open&per_page=100`, '--paginate', '--slurp',
], 'open pull requests')

async function requestReview(pullRequest) {
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

let dispatched = 0
for (const summary of summaries.flat()) {
  const pullRequest = await ghJson([
    'api', `repos/${repository}/pulls/${summary.number}`,
  ], `pull request #${summary.number}`)
  if (pullRequest.draft
    || pullRequest.base?.ref !== defaultBranch
    || pullRequest.head?.repo?.full_name !== repository) continue
  if (pullRequest.mergeable_state === 'behind') {
    await run(githubExecutable, [
      'api', '--method', 'PUT', `repos/${repository}/pulls/${pullRequest.number}/update-branch`,
      '-f', `expected_head_sha=${pullRequest.head.sha}`,
    ], { env: githubEnvironment })
    process.stdout.write(`Updated pull request #${pullRequest.number} from ${defaultBranch}; synchronize will request review.\n`)
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
