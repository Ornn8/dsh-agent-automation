const FULL_SHA = /^[0-9a-f]{40}$/
export const MAX_RECOVERY_ATTEMPTS = 3

function recoveryRole(run, repository, trust) {
  if (run?.repository?.full_name !== repository
    || run.status !== 'completed'
    || !['failure', 'cancelled'].includes(run.conclusion)) return null
  const workflow = run.name === 'Agent Issues' ? '.github/workflows/dsh-issue.yml'
    : ['Agent PR Rework', 'Agent PR CI Repair'].includes(run.name) ? '.github/workflows/dsh-repair.yml'
      : run.name === 'Agent PR Review' ? '.github/workflows/codex-review.yml' : null
  const expectedPath = `${trust?.controllerRepository}/${workflow}@${trust?.controllerSha}`
  if (!workflow || !FULL_SHA.test(trust?.controllerSha || '') || !run.referenced_workflows?.some(reference => reference.path === expectedPath
    && reference.sha === trust.controllerSha)) return null
  if (workflow === '.github/workflows/dsh-issue.yml') return 'issue'
  if (workflow === '.github/workflows/codex-review.yml') {
    return run.head_repository?.full_name === repository
      && ((run.event === 'pull_request_target'
        && run.pull_requests?.some(pullRequest => FULL_SHA.test(pullRequest.base?.sha || '')
          && FULL_SHA.test(pullRequest.head?.sha || '') && run.head_sha === pullRequest.base.sha))
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
  return jobs?.some(job => job.name === 'codex-review / codex/review'
    && job.conclusion === 'failure'
    && job.steps?.some(step => step.name === 'Review exact PR head with Codex' && step.conclusion === 'success')
    && job.steps?.some(step => step.name === 'Publish an independent change work request' && step.conclusion === 'success')
    && job.steps?.some(step => step.name === 'Preserve the blocking review conclusion' && step.conclusion === 'failure'))
}

/** Decide the single idempotent recovery transition after live subject validation. */
export function recoveryDecision({ run, jobs, repository, trust, subject, current, attempts }) {
  const role = trustedFailedAgentRun({ run, repository, trust })
  if ((role !== subject?.type && !(role === 'review' && subject?.type === 'pull-request'))
    || !validSubject(subject, current, repository)) return { action: 'ignore' }
  if (role === 'review' && intentionalReviewBlock(run, jobs)) return { action: 'ignore' }
  const completed = (attempts || []).filter(value => Number.isSafeInteger(value?.attempt) && value.attempt > 0)
  const attempt = completed.reduce((max, value) => Math.max(max, value.attempt), 0)
  if (attempt >= MAX_RECOVERY_ATTEMPTS) return { action: 'dead-letter', attempt }
  const next = attempt + 1
  return { action: 'retry', attempt: next, requestId: `recovery-${run.id}-${next}` }
}
