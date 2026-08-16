import { actionsCredentialEnvironment, parseJson, requiredEnv, run, trustedAssociation } from './common.mjs'
import { explicitResumeCommand } from './dispatch-policy.mjs'
import { governorDecision, subjectStateVersion } from './governor-policy.mjs'
import {
  attestedGovernorRecordBody,
  GOVERNOR_WORKFLOW_PATHS,
  issueGovernorSubject,
  trustedGovernorRecords,
} from './governor-state.mjs'

const repository = requiredEnv('TARGET_REPOSITORY')
const issueNumber = Number.parseInt(requiredEnv('ISSUE_NUMBER'), 10)
const commentId = Number.parseInt(requiredEnv('COMMENT_ID'), 10)
const controllerRepository = requiredEnv('CONTROLLER_REPOSITORY')
const controllerSha = requiredEnv('CONTROLLER_SHA').toLowerCase()
const runId = Number.parseInt(requiredEnv('GITHUB_RUN_ID'), 10)
const githubExecutable = process.env.GH_EXECUTABLE?.trim() || 'gh'
const environment = actionsCredentialEnvironment()

if (!Number.isSafeInteger(issueNumber) || issueNumber < 1
  || !Number.isSafeInteger(commentId) || commentId < 1) throw new Error('Resume subject identifiers are invalid')

async function ghJson(args, description) {
  const result = await run(githubExecutable, args, { env: environment })
  return parseJson(result.stdout, description)
}

const comment = await ghJson(['api', `repos/${repository}/issues/comments/${commentId}`], 'resume comment')
if (!comment.issue_url?.endsWith(`/issues/${issueNumber}`)
  || !trustedAssociation(comment.author_association)
  || !explicitResumeCommand(comment.body)) throw new Error('Comment is not an authorized resume command for this Issue')
const issue = await ghJson(['api', `repos/${repository}/issues/${issueNumber}`], 'paused Issue')
if (issue.pull_request || issue.state !== 'open') throw new Error('Resume target must be an open Issue')
if (!issue.labels?.some(label => label.name === 'automation/paused')) {
  process.stdout.write(`Issue #${issueNumber} is not paused.\n`)
  process.exit(0)
}
const comments = (await ghJson([
  'api', `repos/${repository}/issues/${issueNumber}/comments?per_page=100`, '--paginate', '--slurp',
], 'Issue governor records')).flat()
const trust = { repository, controllerRepository, workflowPaths: GOVERNOR_WORKFLOW_PATHS }
const records = await trustedGovernorRecords({
  comments,
  trust,
  loadRun: candidateRunId => ghJson(['api', `repos/${repository}/actions/runs/${candidateRunId}`], `governor workflow run ${candidateRunId}`),
})
const subject = issueGovernorSubject(issue)
const stateVersion = subjectStateVersion(subject)
const decision = governorDecision({
  transition: 'issue-dispatch', subject, stateVersion,
  observationId: `comment-${commentId}`, records,
  resumeCondition: { authorized: true, commandId: `comment-${commentId}` },
})
if (decision.record) {
  await run(githubExecutable, [
    'api', '--method', 'POST', `repos/${repository}/issues/${issueNumber}/comments`, '--input', '-',
  ], {
    env: environment,
    input: JSON.stringify({
      body: attestedGovernorRecordBody(decision.record, {
        repository,
        controllerRepository,
        controllerSha,
        workflowPath: '.github/workflows/resume-subject.yml',
        runId,
      }),
    }),
  })
}
if (decision.action === 'record-resume') {
  await run(githubExecutable, ['issue', 'edit', String(issueNumber), '--repo', repository, '--remove-label', 'automation/paused'], { env: environment })
}
process.stdout.write(`Governor ${decision.action} for Issue #${issueNumber}.\n`)
