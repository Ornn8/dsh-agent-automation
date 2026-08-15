import { appendFile } from 'node:fs/promises'
import { githubJson } from './supervision-github.mjs'
import { issueTitleSimilarity } from './supervision-protocol.mjs'
import { run } from './common.mjs'

function safeRepositoryPath(value) {
  return Boolean(value) && !value.startsWith('/') && !value.includes('\\')
    && value.split('/').every(segment => segment && segment !== '.' && segment !== '..')
}

function evidenceSourcesFor(action) {
  if (action.type === 'create_issue') return new Set(['master', 'ci', 'upstream'])
  if (action.type === 'comment_issue') return new Set(['master', 'ci', 'upstream', 'issue_state'])
  if (action.type === 'comment_pr') return new Set(['master', 'ci', 'pull_request'])
  if (action.type === 'close_issue') {
    return action.reason === 'completed' ? new Set(['merged_pull_request']) : new Set(['issue_state'])
  }
  return new Set(['issue_state'])
}

/** Map controller close semantics onto the values accepted by GitHub's Issue API. */
export function issueCloseStateReason(reason) {
  if (reason === 'completed') return 'completed'
  if (reason === 'duplicate') return 'not_planned'
  throw new Error(`Unsupported Issue close reason: ${reason}`)
}

async function validateEvidence(action, snapshot, { config, targetCheckout }) {
  const allowed = evidenceSourcesFor(action)
  for (const item of action.evidence) {
    if (!allowed.has(item.source)) throw new Error(`${action.type} cannot use ${item.source} evidence`)

    if (item.source === 'master') {
      const match = item.reference.match(/^(.+):(\d+)$/)
      if (!match || !safeRepositoryPath(match[1])) throw new Error(`Invalid master evidence reference: ${item.reference}`)
      const content = (await run(config.gitExecutable, ['-C', targetCheckout, 'show', `HEAD:${match[1]}`])).stdout
      const line = Number.parseInt(match[2], 10)
      if (line < 1 || line > content.split(/\r?\n/).length) {
        throw new Error(`Master evidence line is outside ${match[1]}: ${line}`)
      }
      continue
    }

    if (item.source === 'ci') {
      const match = item.reference.match(/^run:(\d+)$/)
      const workflowRun = match && snapshot.runs.find(runValue => runValue.id === Number.parseInt(match[1], 10))
      if (!workflowRun || !['failure', 'timed_out', 'cancelled', 'action_required'].includes(workflowRun.conclusion)) {
        throw new Error(`CI evidence does not name a failing audited run: ${item.reference}`)
      }
      continue
    }

    if (item.source === 'upstream') {
      const match = item.reference.match(/^sha:([0-9a-f]{40})$/i)
      if (!match || match[1].toLowerCase() !== snapshot.upstream.headSha.toLowerCase() || snapshot.upstream.behind < 1) {
        throw new Error(`Upstream evidence does not name the current ahead-of-fork upstream head: ${item.reference}`)
      }
      continue
    }

    if (item.source === 'pull_request') {
      const match = item.reference.match(/^#(\d+):(.+):(\d+)$/)
      if (!match || !safeRepositoryPath(match[2])) throw new Error(`Invalid pull request evidence reference: ${item.reference}`)
      const pullRequest = snapshot.pullRequests.find(pr => pr.number === Number.parseInt(match[1], 10))
      if (!pullRequest || !pullRequest.files.some(file => file.path === match[2])) {
        throw new Error(`Pull request evidence path is not in the audited pull request: ${item.reference}`)
      }
      if (action.type === 'comment_pr' && pullRequest.number !== action.number) {
        throw new Error(`comment_pr evidence must name pull request #${action.number}`)
      }
      continue
    }

    if (item.source === 'merged_pull_request') {
      const match = item.reference.match(/^#(\d+)$/)
      const pullRequest = match && snapshot.pullRequests.find(pr => pr.number === Number.parseInt(match[1], 10))
      if (!pullRequest?.mergedAt || !new RegExp(`\\b(?:Closes|Fixes|Resolves)\\s+#${action.number}\\b`, 'i').test(pullRequest.body || '')) {
        throw new Error(`Completed Issue evidence must name a merged closing pull request: ${item.reference}`)
      }
      continue
    }

    const match = item.reference.match(/^#(\d+)$/)
    const issue = match && snapshot.issues.find(issueValue => issueValue.number === Number.parseInt(match[1], 10))
    if (!issue) throw new Error(`Issue-state evidence names an unknown Issue: ${item.reference}`)
    if (action.type === 'close_issue' && action.reason === 'duplicate') {
      if (issue.number !== action.duplicateOf) {
        throw new Error(`Duplicate close evidence must name Issue #${action.duplicateOf}`)
      }
      const duplicate = snapshot.issues.find(issueValue => issueValue.number === action.number)
      if (!duplicate || issueTitleSimilarity(duplicate.title, issue.title) < 0.72) {
        throw new Error(`Issue #${action.number} does not substantially overlap duplicate target #${action.duplicateOf}`)
      }
    }
  }
}

function withMarker(body, marker) {
  return `${marker}\n${body.trim()}`
}

function blockedComment(action) {
  const details = action.blockingReasons.join('; ')
  return withMarker(
    `BLOCKED: Issue #${action.number} cannot execute now because ${details}. DSH must stop, create no commit, push no branch, open no pull request, and discard temporary work.`,
    action.marker,
  )
}

async function executeAction(action, { repository, config, environment }) {
  if (action.type === 'create_issue') {
    await githubJson({
      config,
      environment,
      path: `repos/${repository}/issues`,
      description: 'created Issue',
      method: 'POST',
      input: { title: action.title, body: `${action.body.trim()}\n\n${action.marker}`, labels: action.labels },
    })
    return
  }
  if (action.type === 'comment_issue' || action.type === 'comment_pr') {
    await githubJson({
      config,
      environment,
      path: `repos/${repository}/issues/${action.number}/comments`,
      description: `${action.type} comment`,
      method: 'POST',
      input: { body: withMarker(action.body, action.marker) },
    })
    return
  }
  if (action.type === 'close_issue') {
    await githubJson({
      config,
      environment,
      path: `repos/${repository}/issues/${action.number}`,
      description: `closed Issue #${action.number}`,
      method: 'PATCH',
      input: { state: 'closed', state_reason: issueCloseStateReason(action.reason) },
    })
    return
  }
  if (action.type === 'reopen_issue') {
    await githubJson({
      config,
      environment,
      path: `repos/${repository}/issues/${action.number}`,
      description: `reopened Issue #${action.number}`,
      method: 'PATCH',
      input: { state: 'open', state_reason: 'reopened' },
    })
    return
  }
  if (action.type === 'add_label') {
    await githubJson({
      config,
      environment,
      path: `repos/${repository}/issues/${action.number}/labels`,
      description: `added label to Issue #${action.number}`,
      method: 'POST',
      input: { labels: [action.label] },
    })
    return
  }

  await run(config.ghExecutable, [
    'api', '--method', 'DELETE',
    `repos/${repository}/issues/${action.number}/labels/${encodeURIComponent(action.label)}`,
  ], { env: environment })
  if (action.label === 'agent/dsh' && action.commentRequired) {
    await githubJson({
      config,
      environment,
      path: `repos/${repository}/issues/${action.number}/comments`,
      description: `blocked Issue #${action.number} comment`,
      method: 'POST',
      input: { body: blockedComment(action) },
    })
  }
}

/** Validate every action before applying the first mutation, then execute sequentially. */
export async function applySupervisionPlan({
  plan,
  snapshot,
  repository,
  config,
  environment,
  targetCheckout,
  applyChanges,
}) {
  for (const action of plan.actions) await validateEvidence(action, snapshot, { config, targetCheckout })
  if (!applyChanges) return
  for (const action of plan.actions) await executeAction(action, { repository, config, environment })
}

/** Write an English GitHub Actions summary for applied and dry-run audits. */
export async function writeSupervisionSummary({ proposal, plan, repository, applyChanges }) {
  const path = process.env.GITHUB_STEP_SUMMARY
  if (!path) return
  const lines = [
    '# Repository supervision',
    '',
    `- Target: \`${repository}\``,
    `- Mode: **${applyChanges ? 'apply' : 'dry run'}**`,
    `- Proposed actions: ${proposal.actions.length}`,
    `- Planned mutations: ${plan.mutationCount}`,
    `- Summary: ${proposal.summary}`,
  ]
  if (plan.actions.length > 0) {
    lines.push('', '## Planned actions', '')
    for (const action of plan.actions) lines.push(`- \`${action.type}\` - \`${action.fingerprint}\``)
  }
  await appendFile(path, `${lines.join('\n')}\n`)
}
