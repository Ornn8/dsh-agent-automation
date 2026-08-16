import {
  actionsCredentialEnvironment,
  parseJson,
  requiredEnv,
  run,
  trustedAssociation,
} from './common.mjs'
import { explicitResumeCommand, explicitReworkCommand } from './dispatch-policy.mjs'
import { governorDecision, subjectStateVersion } from './governor-policy.mjs'
import {
  attestedGovernorRecordBody,
  GOVERNOR_WORKFLOW_PATHS,
  pullRequestGovernorSubject,
  trustedGovernorRecords,
} from './governor-state.mjs'

const repository = requiredEnv('TARGET_REPOSITORY')
const pullRequestNumber = Number.parseInt(requiredEnv('PR_NUMBER'), 10)
const commentId = Number.parseInt(requiredEnv('COMMENT_ID'), 10)
const controllerRepository = requiredEnv('CONTROLLER_REPOSITORY')
const controllerSha = requiredEnv('CONTROLLER_SHA').toLowerCase()
const runId = Number.parseInt(requiredEnv('GITHUB_RUN_ID'), 10)
const githubExecutable = process.env.GH_EXECUTABLE?.trim() || 'gh'
const environment = actionsCredentialEnvironment()
const trust = {
  repository,
  controllerRepository,
  workflowPaths: GOVERNOR_WORKFLOW_PATHS,
}
const writerTrust = {
  repository,
  controllerRepository,
  controllerSha,
  workflowPath: '.github/workflows/wake-rework.yml',
}

if (!Number.isSafeInteger(pullRequestNumber) || pullRequestNumber < 1) throw new Error('Invalid PR_NUMBER')
if (!Number.isSafeInteger(commentId) || commentId < 1) throw new Error('Invalid COMMENT_ID')

async function ghJson(args, description) {
  const result = await run(githubExecutable, args, { env: environment })
  return parseJson(result.stdout, description)
}

async function writeRecord(record) {
  await run(githubExecutable, [
    'api', '--method', 'POST', `repos/${repository}/issues/${pullRequestNumber}/comments`, '--input', '-',
  ], {
    env: environment,
    input: JSON.stringify({ body: attestedGovernorRecordBody(record, { ...writerTrust, runId }) }),
  })
}

const comment = await ghJson(['api', `repos/${repository}/issues/comments/${commentId}`], 'rework comment')
if (!comment.issue_url?.endsWith(`/issues/${pullRequestNumber}`)) throw new Error('Comment does not belong to the requested pull request')
if (!trustedAssociation(comment.author_association)) throw new Error(`Untrusted comment association ${comment.author_association}`)
const rework = explicitReworkCommand(comment.body)
const resume = explicitResumeCommand(comment.body)
if (!rework && !resume) throw new Error('Comment is not an explicit automation rework or resume command')

const pullRequest = await ghJson(['api', `repos/${repository}/pulls/${pullRequestNumber}`], 'pull request')
if (pullRequest.state !== 'open' || pullRequest.draft) throw new Error('Pull request is not open and ready')
if (pullRequest.head.repo?.full_name !== repository) throw new Error('Fork pull requests cannot reach privileged change work')
const comments = (await ghJson([
  'api', `repos/${repository}/issues/${pullRequestNumber}/comments?per_page=100`, '--paginate', '--slurp',
], 'pull request governor records')).flat()
const records = await trustedGovernorRecords({
  comments,
  trust,
  loadRun: candidateRunId => ghJson(['api', `repos/${repository}/actions/runs/${candidateRunId}`], `governor workflow run ${candidateRunId}`),
})
const subject = pullRequestGovernorSubject(pullRequest)
const stateVersion = subjectStateVersion(subject)
const decision = governorDecision({
  transition: 'review-repair',
  subject,
  stateVersion,
  observationId: `comment-${commentId}`,
  records,
  ...(resume ? { resumeCondition: { authorized: true, commandId: `comment-${commentId}` } } : {}),
})
if (decision.record) await writeRecord(decision.record)
if (resume && decision.action === 'record-resume') {
  await run(githubExecutable, [
    'pr', 'edit', String(pullRequestNumber), '--repo', repository,
    '--remove-label', 'automation/paused',
  ], { env: environment })
}
process.stdout.write(resume
  ? `Recorded authorized resume for pull request #${pullRequestNumber}; a later observation will evaluate admission.\n`
  : `Recorded rework candidate for pull request #${pullRequestNumber}; a later observation will evaluate admission.\n`)
