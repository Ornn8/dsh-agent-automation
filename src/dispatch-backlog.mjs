import {
  actionsCredentialEnvironment,
  parseJson,
  requiredEnv,
  run,
} from './common.mjs'
import { selectBacklogWork, trustedBlockedReviewProof } from './dispatch-policy.mjs'
import { reviewRunIdFromDetailsUrl } from './landing-policy.mjs'

const repository = requiredEnv('TARGET_REPOSITORY')
const githubExecutable = process.env.GH_EXECUTABLE?.trim() || 'gh'
const githubEnvironment = actionsCredentialEnvironment()
const trustedReview = {
  controllerRepository: requiredEnv('TRUSTED_CONTROLLER_REPOSITORY'),
  controllerSha: requiredEnv('TRUSTED_CONTROLLER_SHA'),
  workflowPath: requiredEnv('TRUSTED_REVIEW_WORKFLOW_PATH'),
}

if (!/^[0-9a-f]{40}$/i.test(trustedReview.controllerSha)) {
  throw new Error('TRUSTED_CONTROLLER_SHA must be a full commit SHA')
}

async function ghJson(args, description) {
  const result = await run(githubExecutable, args, { env: githubEnvironment })
  return parseJson(result.stdout, description)
}

async function ghPages(path, description) {
  const pages = await ghJson(['api', path, '--paginate', '--slurp'], description)
  return pages.flat()
}

async function trustedBlockedRepairNumbers(pullRequests) {
  const result = new Set()
  for (const candidate of pullRequests) {
    if (candidate.draft || candidate.head?.repo?.full_name !== repository
      || !candidate.labels?.some(label => label.name === 'automation/review-blocked')) continue
    const pullRequest = {
      number: candidate.number,
      repository,
      state: candidate.state?.toUpperCase(),
      isDraft: candidate.draft,
      baseRefName: candidate.base?.ref,
      baseRefOid: candidate.base?.sha,
      headRefOid: candidate.head?.sha,
    }
    if (typeof pullRequest.baseRefOid !== 'string' || typeof pullRequest.headRefOid !== 'string') continue
    const pages = await ghJson([
      'api', `repos/${repository}/commits/${pullRequest.headRefOid}/check-runs`, '--paginate', '--slurp',
    ], `check runs for pull request #${pullRequest.number}`)
    for (const checkRun of pages.flatMap(page => page.check_runs || [])) {
      if (checkRun.name !== 'codex/review') continue
      const runId = reviewRunIdFromDetailsUrl(checkRun.details_url, repository)
      if (!runId) continue
      const workflowRun = await ghJson([
        'api', `repos/${repository}/actions/runs/${runId}`,
      ], `review workflow run ${runId}`)
      if (trustedBlockedReviewProof({
        pullRequest,
        reviewProof: { checkRun, run: workflowRun },
        trustedReview,
      })) {
        result.add(pullRequest.number)
        break
      }
    }
  }
  return result
}

const pullRequests = await ghPages(`repos/${repository}/pulls?state=open&per_page=100`, 'open pull requests')
const issues = (await ghPages(`repos/${repository}/issues?state=all&per_page=100`, 'Issues'))
  .filter(issue => !issue.pull_request)
const work = selectBacklogWork({
  repository,
  pullRequests,
  issues,
  trustedBlockedRepairNumbers: await trustedBlockedRepairNumbers(pullRequests),
})

if (!work) {
  process.stdout.write('No eligible DSH backlog work is ready.\n')
  process.exit(0)
}

if (work.type === 'repair') {
  await run(githubExecutable, [
    'api', '--method', 'POST', `repos/${repository}/dispatches`,
    '-f', 'event_type=dsh-repair',
    '-F', `client_payload[pr_number]=${work.number}`,
    '-f', `client_payload[head_sha]=${work.head}`,
    '-f', 'client_payload[request_id]=backlog',
  ], { env: githubEnvironment })
  process.stdout.write(`Dispatched blocked pull request #${work.number} at ${work.head}.\n`)
} else {
  await run(githubExecutable, [
    'issue', 'edit', String(work.number), '--repo', repository, '--add-label', 'agent/dsh',
  ], { env: githubEnvironment })
  await run(githubExecutable, [
    'api', '--method', 'POST', `repos/${repository}/dispatches`,
    '-f', 'event_type=dsh-issue',
    '-F', `client_payload[issue_number]=${work.number}`,
    '-f', `client_payload[request_id]=${work.requestId || `backlog-${work.number}`}`,
  ], { env: githubEnvironment })
  process.stdout.write(`Dispatched Issue #${work.number} through the trusted repository event.\n`)
}
