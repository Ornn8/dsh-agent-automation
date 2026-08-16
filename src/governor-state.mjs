import { governorRecordBody, parseGovernorRecord } from './governor-policy.mjs'
import { REVIEW_WORKFLOW_PATH } from './review-authority.mjs'

const FULL_SHA = /^[0-9a-f]{40}$/
const ATTESTATION_PATTERN = /^- Controller workflow: `([^`\r\n]+)`$/m
const RUN_PATTERN = /^- Run: https:\/\/github\.com\/([^/\s]+\/[^/\s]+)\/actions\/runs\/(\d+)$/m
export const GOVERNOR_WORKFLOW_PATHS = Object.freeze([
  REVIEW_WORKFLOW_PATH,
  '.github/workflows/dispatch-backlog.yml',
  '.github/workflows/dsh-repair.yml',
  '.github/workflows/reconcile-reviews.yml',
  '.github/workflows/recover-backlog.yml',
  '.github/workflows/repository-supervisor.yml',
  '.github/workflows/resume-subject.yml',
  '.github/workflows/resume-fault.yml',
  '.github/workflows/wake-rework.yml',
])

function validatedTrust(trust) {
  const workflowPaths = trust?.workflowPaths || [trust?.workflowPath]
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(trust?.repository || '')
    || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(trust?.controllerRepository || '')
    || !Array.isArray(workflowPaths) || workflowPaths.length < 1
    || workflowPaths.some(path => !/^\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml$/.test(path || ''))) {
    throw new Error('Governor workflow trust is incomplete')
  }
  return trust
}

function workflowReference(trust) {
  if (!FULL_SHA.test(trust?.controllerSha || '')) throw new Error('Governor controllerSha must be a full lowercase SHA')
  return `${trust.controllerRepository}/${trust.workflowPath}@${trust.controllerSha}`
}

/** Render a controller record with independently verifiable GitHub Actions provenance. */
export function attestedGovernorRecordBody(record, { runId, ...trust }) {
  validatedTrust(trust)
  if (!Number.isSafeInteger(runId) || runId < 1) throw new Error('Governor runId must be positive')
  return [
    '### Automation governor',
    '',
    `- Run: https://github.com/${trust.repository}/actions/runs/${runId}`,
    `- Controller workflow: \`${workflowReference(trust)}\``,
    '',
    governorRecordBody(record),
  ].join('\n')
}

/** Load controller-authored records only after checking the pinned reusable workflow run. */
export async function trustedGovernorRecords({ comments, trust, loadRun }) {
  validatedTrust(trust)
  if (!Array.isArray(comments) || typeof loadRun !== 'function') {
    throw new Error('Governor state loading requires comments and a run resolver')
  }
  const records = []
  for (const comment of comments) {
    if (!String(comment?.body || '').includes('<!-- automation-governor\n')) continue
    if (comment?.user?.login !== 'github-actions[bot]') continue
    const runMatch = String(comment.body).match(RUN_PATTERN)
    const attestation = String(comment.body).match(ATTESTATION_PATTERN)?.[1]
    const allowedPaths = trust.workflowPaths || [trust.workflowPath]
    const matchedPath = allowedPaths.find(path => attestation?.startsWith(`${trust.controllerRepository}/${path}@`))
    const expectedPrefix = matchedPath ? `${trust.controllerRepository}/${matchedPath}@` : ''
    const attestedSha = expectedPrefix ? attestation.slice(expectedPrefix.length) : ''
    if (!runMatch || runMatch[1] !== trust.repository || !matchedPath || !FULL_SHA.test(attestedSha)) {
      throw new Error('Governor record attestation fields are inconsistent')
    }
    const runId = Number.parseInt(runMatch[2], 10)
    const run = await loadRun(runId)
    const attested = run?.id === runId
      && run.repository?.full_name === trust.repository
      && run.referenced_workflows?.some(reference => reference.path === attestation
        && reference.sha === attestedSha)
    if (!attested) throw new Error(`Governor record run ${runId} is not attested by the pinned controller workflow`)
    records.push(parseGovernorRecord(comment.body))
  }
  return records
}

/** Convert one GitHub Issue response into the semantic governor subject. */
export function issueGovernorSubject(issue) {
  return {
    type: 'issue',
    number: issue?.number,
    state: issue?.state,
    title: issue?.title,
    body: issue?.body || '',
    labels: issue?.labels || [],
  }
}

/** Convert one GitHub pull request response into the semantic governor subject. */
export function pullRequestGovernorSubject(pullRequest) {
  return {
    type: 'pull-request',
    number: pullRequest?.number,
    state: pullRequest?.state,
    draft: Boolean(pullRequest?.draft),
    base: pullRequest?.base?.sha,
    head: pullRequest?.head?.sha,
    labels: pullRequest?.labels || [],
  }
}
