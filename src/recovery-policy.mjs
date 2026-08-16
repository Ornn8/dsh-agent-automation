import { REVIEW_WORKFLOW_PATH } from './review-authority.mjs'

const FULL_SHA = /^[0-9a-f]{40}$/
const RECOVERABLE_CONCLUSIONS = new Set([
  'failure', 'cancelled', 'timed_out', 'startup_failure', 'stale',
])

/** Return the exact CI workflow name recorded by a trusted repair status comment. */
export function recordedCiWorkflow(body) {
  const matches = [...String(body || '').matchAll(/^- CI workflow: `([^`\r\n]{1,100})`$/gm)]
  return matches.length === 1 ? matches[0][1] : null
}

function recoveryRole(run, repository, trust) {
  if (run?.repository?.full_name !== repository
    || run.status !== 'completed'
    || !RECOVERABLE_CONCLUSIONS.has(run.conclusion)) return null
  if (!FULL_SHA.test(trust?.controllerSha || '')) return null
  const workflow = [
    '.github/workflows/dsh-issue.yml',
    '.github/workflows/dsh-repair.yml',
    REVIEW_WORKFLOW_PATH,
  ].find(candidate => run.referenced_workflows?.some(reference => reference.path
    === `${trust.controllerRepository}/${candidate}@${trust.controllerSha}`
    && reference.sha === trust.controllerSha))
  if (!workflow) return null
  if (workflow === '.github/workflows/dsh-issue.yml') return 'issue'
  if (workflow === REVIEW_WORKFLOW_PATH) {
    return run.head_repository?.full_name === repository
      && ((run.event === 'pull_request_target'
        && run.pull_requests?.some(pullRequest => FULL_SHA.test(pullRequest.base?.sha || '')
          && FULL_SHA.test(pullRequest.head?.sha || '') && run.head_sha === pullRequest.head.sha))
        || (run.event === 'repository_dispatch' && FULL_SHA.test(run.head_sha || '')))
      ? 'review' : null
  }
  return 'pull-request'
}

/** Return the recoverable subject role for one trusted failed top-level agent workflow run. */
export function trustedFailedAgentRun({ run, repository, trust }) {
  return recoveryRole(run, repository, trust)
}

/** Render an auditable, non-authorizing durable recovery record. */
export function recoveryMarkerBody(subject, attempt, sourceRunId, status, repository) {
  const head = subject.type === 'pull-request'
    ? `:${subject.base ? `${subject.base}:` : ''}${subject.head}` : ''
  return [
    `<!-- dsh-recovery:${subject.type}:${subject.number}${head} -->`,
    '### DSH recovery',
    '',
    `- Status: **${status}**`,
    `- Attempt: ${attempt}`,
    `- Source run: https://github.com/${repository}/actions/runs/${sourceRunId}`,
    '',
    '_This record is audit state. The trusted workflow run and current subject checks authorize recovery._',
  ].join('\n')
}

function validSubject(subject, current, repository) {
  if (subject?.type === 'issue') return Number.isSafeInteger(subject.number)
    && subject.number > 0 && current?.state === 'open'
  return subject?.type === 'pull-request'
    && Number.isSafeInteger(subject.number) && subject.number > 0
    && FULL_SHA.test(subject.head || '')
    && current?.state === 'open'
    && (subject.base === undefined || (FULL_SHA.test(subject.base) && current.base?.sha === subject.base))
    && current.head?.sha === subject.head
    && current.head?.repo?.full_name === repository
}

/** Return whether trusted review-job steps prove an intentional BLOCK rather than infrastructure failure. */
export function intentionalReviewBlock(run, jobs) {
  if (run?.conclusion !== 'failure') return false
  return jobs?.some(job => job.name === 'agent-review / agent/review'
    && job.conclusion === 'failure'
    && job.steps?.some(step => step.name === 'Review exact PR head with Codex' && step.conclusion === 'success')
    && job.steps?.some(step => step.name === 'Publish an independent change work request' && step.conclusion === 'success')
    && job.steps?.some(step => step.name === 'Preserve the blocking review conclusion' && step.conclusion === 'failure'))
}

/** Decide the single idempotent recovery transition after live subject validation. */
export function recoveryDecision({ run, jobs, repository, trust, subject, current, attempts, failureClass }) {
  const role = trustedFailedAgentRun({ run, repository, trust })
  if ((role !== subject?.type && !(role === 'review' && subject?.type === 'pull-request'))
    || !validSubject(subject, current, repository)) return { action: 'ignore' }
  if (role === 'review' && intentionalReviewBlock(run, jobs)) return { action: 'ignore' }
  const completed = (attempts || []).filter(value => Number.isSafeInteger(value?.attempt) && value.attempt > 0)
  const attempt = completed.reduce((max, value) => Math.max(max, value.attempt), 0)
  if (['auth-quota', 'protocol'].includes(failureClass)) {
    return { action: 'dead-letter', attempt, reason: failureClass }
  }
  const next = attempt + 1
  const decision = {
    action: 'retry',
    attempt: next,
    requestId: `recovery-${run.id}-${next}`,
  }
  if (failureClass === 'transport') decision.delaySeconds = [30, 120, 300][next - 1]
  return decision
}
