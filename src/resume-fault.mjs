import { actionsCredentialEnvironment, parseJson, requiredEnv, run } from './common.mjs'
import { trustedFaultRecords } from './fault-attestation.mjs'
import { parseFaultProjection } from './fault-projection.mjs'
import { governorDecision, subjectStateVersion } from './governor-policy.mjs'
import {
  attestedGovernorRecordBody,
  GOVERNOR_WORKFLOW_PATHS,
  issueGovernorSubject,
  pullRequestGovernorSubject,
  trustedGovernorRecords,
} from './governor-state.mjs'

const repository = requiredEnv('TARGET_REPOSITORY')
const subjectType = requiredEnv('SUBJECT_TYPE')
const subjectNumber = Number.parseInt(requiredEnv('SUBJECT_NUMBER'), 10)
const faultIssueNumber = Number.parseInt(requiredEnv('FAULT_ISSUE_NUMBER'), 10)
const faultId = requiredEnv('FAULT_ID')
const controllerRepository = requiredEnv('CONTROLLER_REPOSITORY')
const controllerSha = requiredEnv('CONTROLLER_SHA').toLowerCase()
const runId = Number.parseInt(requiredEnv('GITHUB_RUN_ID'), 10)
const githubExecutable = process.env.GH_EXECUTABLE?.trim() || 'gh'
const environment = actionsCredentialEnvironment()

if (!['issue', 'pull-request'].includes(subjectType)
  || !Number.isSafeInteger(subjectNumber) || subjectNumber < 1
  || !Number.isSafeInteger(faultIssueNumber) || faultIssueNumber < 1
  || !/^[0-9a-f]{64}$/.test(faultId)
  || !/^[0-9a-f]{40}$/.test(controllerSha)
  || !Number.isSafeInteger(runId) || runId < 1) throw new Error('Recovered fault resume identity is invalid')

async function ghJson(args, description) {
  const result = await run(githubExecutable, args, { env: environment })
  return parseJson(result.stdout, description)
}

async function pages(path, description) {
  const values = []
  for (let page = 1; page <= 3; page += 1) {
    const result = await ghJson(['api', `${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`], description)
    if (!Array.isArray(result)) throw new Error(`${description} did not return an array`)
    values.push(...result)
    if (result.length < 100) return values
  }
  throw new Error(`${description} exceeded the bounded three-page snapshot`)
}

const faultIssue = await ghJson(['api', `repos/${repository}/issues/${faultIssueNumber}`], 'fault Issue')
const projection = parseFaultProjection(faultIssue.body)
if (projection.faultId !== faultId || projection.repository !== repository) throw new Error('Fault projection does not match the resume request')
const faultComments = await pages(`repos/${repository}/issues/${faultIssueNumber}/comments`, 'fault comments')
const faultRecords = await trustedFaultRecords({
  comments: faultComments,
  faultId,
  controllerRepository,
  loadRun: candidateRunId => ghJson(['api', `repos/${controllerRepository}/actions/runs/${candidateRunId}`], `Controller maintenance run ${candidateRunId}`),
})
const recovered = faultRecords.map(item => item.record).findLast(record => record.status === 'recovered')
const requestId = `${subjectType}-${subjectNumber}`
if (!recovered || !recovered.rootRequestIds.includes(requestId)) throw new Error('No trusted recovered FaultRecord owns this WorkRequest')

const current = subjectType === 'issue'
  ? await ghJson(['api', `repos/${repository}/issues/${subjectNumber}`], 'paused Issue')
  : await ghJson(['api', `repos/${repository}/pulls/${subjectNumber}`], 'paused pull request')
if (current.state !== 'open') {
  process.stdout.write(`${requestId} is no longer open.\n`)
  process.exit(0)
}
if (!current.labels?.some(label => label.name === 'automation/paused')) {
  process.stdout.write(`${requestId} is already resumed.\n`)
  process.exit(0)
}
const subject = subjectType === 'issue' ? issueGovernorSubject(current) : pullRequestGovernorSubject(current)
const comments = await pages(`repos/${repository}/issues/${subjectNumber}/comments`, 'subject governor comments')
const records = await trustedGovernorRecords({
  comments,
  trust: { repository, controllerRepository, workflowPaths: GOVERNOR_WORKFLOW_PATHS },
  loadRun: candidateRunId => ghJson(['api', `repos/${repository}/actions/runs/${candidateRunId}`], `governor workflow run ${candidateRunId}`),
})
const stateVersion = subjectStateVersion(subject)
const observationId = `fault-${faultId}-run-${runId}`
const decision = governorDecision({
  transition: subjectType === 'issue' ? 'issue-dispatch' : 'workflow-recovery',
  subject,
  stateVersion,
  observationId,
  records,
  resumeCondition: { authorized: true, commandId: `fault-${faultId}` },
})
if (decision.action !== 'record-resume' || !decision.record) throw new Error('Recovered fault did not match the active Governor pause')
await run(githubExecutable, ['api', '--method', 'POST', `repos/${repository}/issues/${subjectNumber}/comments`, '--input', '-'], {
  env: environment,
  input: JSON.stringify({
    body: attestedGovernorRecordBody(decision.record, {
      repository,
      controllerRepository,
      controllerSha,
      workflowPath: '.github/workflows/resume-fault.yml',
      runId,
    }),
  }),
})
await run(githubExecutable, [subjectType === 'issue' ? 'issue' : 'pr', 'edit', String(subjectNumber), '--repo', repository,
  '--remove-label', 'automation/paused'], { env: environment })
if (subjectType === 'issue') {
  await run(githubExecutable, ['api', '--method', 'POST', `repos/${repository}/dispatches`,
    '-f', 'event_type=agent_backlog_reconcile'], { env: environment })
} else {
  await run(githubExecutable, ['api', '--method', 'POST', `repos/${repository}/dispatches`,
    '-f', 'event_type=dsh-advance',
    '-F', `client_payload[pull_request_number]=${subjectNumber}`,
    '-f', `client_payload[base_sha]=${current.base.sha}`,
    '-f', `client_payload[head_sha]=${current.head.sha}`,
    '-f', `client_payload[request_id]=fault-${faultId}`], { env: environment })
}
process.stdout.write(`Resumed ${requestId} from recovered fault ${faultId}.\n`)
