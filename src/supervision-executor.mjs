import { appendFile } from 'node:fs/promises'
import { githubJson, githubPages } from './supervision-github.mjs'
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

function referencedLine(content, line, reference) {
  const lines = String(content).split(/\r?\n/)
  if (line < 1 || line > lines.length) throw new Error(`Evidence line is outside ${reference}`)
  return lines[line - 1]
}

function assertEvidenceExcerpt(item, content, line) {
  if (!referencedLine(content, line, item.reference).includes(item.excerpt)) {
    throw new Error(`Evidence excerpt does not match line ${line} of ${item.reference}`)
  }
}

function addedPatchLine(patch, line) {
  let newLine
  for (const text of String(patch || '').split(/\r?\n/)) {
    const hunk = text.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/)
    if (hunk) {
      newLine = Number.parseInt(hunk[1], 10)
      continue
    }
    if (newLine === undefined || text.startsWith('\\')) continue
    if (text.startsWith('+') && !text.startsWith('+++')) {
      if (newLine === line) return text.slice(1)
      newLine += 1
      continue
    }
    if (text.startsWith('-') && !text.startsWith('---')) continue
    if (text.startsWith(' ')) newLine += 1
  }
  return undefined
}

function assertChangedEvidenceExcerpt(item, patch, line) {
  const changedLine = addedPatchLine(patch, line)
  if (changedLine === undefined || !changedLine.includes(item.excerpt)) {
    throw new Error(`Evidence excerpt does not match a changed line ${line} of ${item.reference}`)
  }
}

function encodedRepositoryPath(path) {
  return path.split('/').map(segment => encodeURIComponent(segment)).join('/')
}

/** Map controller close semantics onto the values accepted by GitHub's Issue API. */
export function issueCloseStateReason(reason) {
  if (reason === 'completed') return 'completed'
  if (reason === 'duplicate') return 'not_planned'
  throw new Error(`Unsupported Issue close reason: ${reason}`)
}

export async function validateSupervisionEvidence(action, snapshot, {
  config,
  targetCheckout,
  environment,
  repository = snapshot?.repository,
  runCommand = run,
  githubRequest = githubJson,
}) {
  const allowed = evidenceSourcesFor(action)
  for (const item of action.evidence) {
    if (!allowed.has(item.source)) throw new Error(`${action.type} cannot use ${item.source} evidence`)

    if (item.source === 'master') {
      const match = item.reference.match(/^(.+):(\d+)$/)
      if (!match || !safeRepositoryPath(match[1])) throw new Error(`Invalid master evidence reference: ${item.reference}`)
      const content = (await runCommand(config.gitExecutable, ['-C', targetCheckout, 'show', `HEAD:${match[1]}`])).stdout
      const line = Number.parseInt(match[2], 10)
      assertEvidenceExcerpt(item, content, line)
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
      const match = item.reference.match(/^sha:([0-9a-f]{40}):(.+):(\d+)$/i)
      if (!match || !safeRepositoryPath(match[2]) || snapshot.upstream.behind < 1) {
        throw new Error(`Invalid upstream evidence reference: ${item.reference}`)
      }
      const commit = match[1].toLowerCase()
      const upstreamMergeBase = (await runCommand(config.gitExecutable, [
        '-C', targetCheckout, 'merge-base', commit, snapshot.upstream.gitRef,
      ])).stdout.trim().toLowerCase()
      if (upstreamMergeBase !== commit) throw new Error(`Upstream evidence commit is not reachable from the audited upstream head: ${commit}`)
      const targetMergeBase = (await runCommand(config.gitExecutable, [
        '-C', targetCheckout, 'merge-base', commit, 'HEAD',
      ])).stdout.trim().toLowerCase()
      if (targetMergeBase === commit) throw new Error(`Upstream evidence commit is already present in the target default branch: ${commit}`)
      const content = (await runCommand(config.gitExecutable, [
        '-C', targetCheckout, 'show', `${commit}:${match[2]}`,
      ])).stdout
      const line = Number.parseInt(match[3], 10)
      assertEvidenceExcerpt(item, content, line)
      const patch = (await runCommand(config.gitExecutable, [
        '-C', targetCheckout, 'show', '--format=', '--unified=0', '--no-ext-diff', commit, '--', match[2],
      ])).stdout
      assertChangedEvidenceExcerpt(item, patch, line)
      continue
    }

    if (item.source === 'pull_request') {
      const match = item.reference.match(/^#(\d+):(.+):(\d+)$/)
      if (!match || !safeRepositoryPath(match[2])) throw new Error(`Invalid pull request evidence reference: ${item.reference}`)
      const pullRequest = snapshot.pullRequests.find(pr => pr.number === Number.parseInt(match[1], 10))
      const changedFile = pullRequest?.files.find(file => file.path === match[2])
      if (!pullRequest || !changedFile) {
        throw new Error(`Pull request evidence path is not in the audited pull request: ${item.reference}`)
      }
      if (action.type === 'comment_pr' && pullRequest.number !== action.number) {
        throw new Error(`comment_pr evidence must name pull request #${action.number}`)
      }
      const file = await githubRequest({
        config,
        environment,
        path: `repos/${repository}/contents/${encodedRepositoryPath(match[2])}?ref=${encodeURIComponent(pullRequest.head.sha)}`,
        description: `pull request #${pullRequest.number} evidence file`,
      })
      if (file?.encoding !== 'base64' || typeof file.content !== 'string') {
        throw new Error(`Pull request evidence file is not a base64 GitHub file: ${item.reference}`)
      }
      const line = Number.parseInt(match[3], 10)
      assertEvidenceExcerpt(item, Buffer.from(file.content.replace(/\s/g, ''), 'base64').toString('utf8'), line)
      assertChangedEvidenceExcerpt(item, changedFile.patch, line)
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
    `BLOCKED: Issue #${action.number} cannot execute now because ${details}. The assigned change agent must stop, create no commit, push no branch, open no pull request, and discard temporary work.`,
    action.marker,
  )
}

function labelValues(labels) {
  return (labels || []).map(label => typeof label === 'string' ? label : label.name).filter(Boolean).sort()
}

function issueMutationIdentity(issue) {
  return JSON.stringify({
    state: issue?.state,
    stateReason: issue?.stateReason ?? issue?.state_reason ?? null,
    updatedAt: issue?.updatedAt ?? issue?.updated_at,
    title: issue?.title,
    body: issue?.body,
    labels: labelValues(issue?.labels),
  })
}

function issueIdentityAfterLabelRemoval(issue, label) {
  return JSON.stringify({
    state: issue?.state,
    stateReason: issue?.stateReason ?? issue?.state_reason ?? null,
    title: issue?.title,
    body: issue?.body,
    labels: labelValues(issue?.labels).filter(value => value !== label),
  })
}

function currentIssueIdentityAfterLabelRemoval(issue) {
  return JSON.stringify({
    state: issue?.state,
    stateReason: issue?.stateReason ?? issue?.state_reason ?? null,
    title: issue?.title,
    body: issue?.body,
    labels: labelValues(issue?.labels),
  })
}

function pullRequestMutationIdentity(pullRequest) {
  return JSON.stringify({
    state: pullRequest?.state,
    draft: Boolean(pullRequest?.draft),
    updatedAt: pullRequest?.updatedAt ?? pullRequest?.updated_at,
    mergedAt: pullRequest?.mergedAt ?? pullRequest?.merged_at ?? null,
    closedAt: pullRequest?.closedAt ?? pullRequest?.closed_at ?? null,
    title: pullRequest?.title,
    body: pullRequest?.body,
    labels: labelValues(pullRequest?.labels),
    headRef: pullRequest?.head?.ref,
    headSha: pullRequest?.head?.sha,
    baseRef: pullRequest?.base?.ref,
    baseSha: pullRequest?.base?.sha,
  })
}

async function assertMutationTargetCurrent(action, snapshot, {
  repository,
  config,
  environment,
  githubRequest,
}) {
  if (action.type === 'create_issue') {
    const currentIssues = await githubPages({
      config,
      environment,
      path: `repos/${repository}/issues?state=all&sort=updated&direction=desc`,
      description: 'live Issues before Issue creation',
      request: githubRequest,
    })
    const duplicate = currentIssues.find(issue => !issue.pull_request && issueTitleSimilarity(action.title, issue.title) >= 0.72)
    if (duplicate) throw new Error(`Repository state changed before create_issue: Issue #${duplicate.number} now overlaps the proposal`)
    return
  }

  if (action.type === 'comment_pr') {
    const audited = snapshot.pullRequests.find(pullRequest => pullRequest.number === action.number)
    const current = await githubRequest({
      config, environment, path: `repos/${repository}/pulls/${action.number}`, description: `pull request #${action.number} mutation precondition`,
    })
    if (!audited || pullRequestMutationIdentity(audited) !== pullRequestMutationIdentity(current)) {
      throw new Error(`Pull request #${action.number} changed before its supervision mutation`)
    }
    return
  }

  const numbers = action.type === 'close_issue' && action.reason === 'duplicate'
    ? [action.number, action.duplicateOf]
    : [action.number]
  for (const number of numbers) {
    const audited = snapshot.issues.find(issue => issue.number === number)
    const current = await githubRequest({
      config, environment, path: `repos/${repository}/issues/${number}`, description: `Issue #${number} mutation precondition`,
    })
    if (!audited || issueMutationIdentity(audited) !== issueMutationIdentity(current)) {
      throw new Error(`Issue #${number} changed before its supervision mutation`)
    }
  }
}

async function executeAction(action, { repository, config, environment, githubRequest, snapshot }) {
  if (action.type === 'create_issue') {
    await githubRequest({
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
    await githubRequest({
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
    await githubRequest({
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
    await githubRequest({
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
    await githubRequest({
      config,
      environment,
      path: `repos/${repository}/issues/${action.number}/labels`,
      description: `added label to Issue #${action.number}`,
      method: 'POST',
      input: { labels: [action.label] },
    })
    return
  }

  await githubRequest({
    config,
    environment,
    path: `repos/${repository}/issues/${action.number}/labels/${encodeURIComponent(action.label)}`,
    description: `removed label from Issue #${action.number}`,
    method: 'DELETE',
  })
  if (action.label === 'agent/dsh' && action.commentRequired) {
    const audited = snapshot.issues.find(issue => issue.number === action.number)
    const current = await githubRequest({
      config,
      environment,
      path: `repos/${repository}/issues/${action.number}`,
      description: `Issue #${action.number} blocked-comment precondition`,
    })
    if (!audited || issueIdentityAfterLabelRemoval(audited, action.label) !== currentIssueIdentityAfterLabelRemoval(current)) {
      throw new Error(`Issue #${action.number} changed before its blocked supervision comment`)
    }
    await githubRequest({
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
  githubRequest = githubJson,
  runCommand = run,
}) {
  for (const action of plan.actions) {
    await validateSupervisionEvidence(action, snapshot, {
      config, targetCheckout, environment, repository, githubRequest, runCommand,
    })
  }
  if (!applyChanges) return
  for (const action of plan.actions) {
    await assertMutationTargetCurrent(action, snapshot, {
      repository, config, environment, githubRequest,
    })
    await executeAction(action, {
      repository, config, environment, githubRequest, snapshot,
    })
  }
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
