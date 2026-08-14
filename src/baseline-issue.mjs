/** Return the canonical GitHub Issue URL for one repository-local number. */
export function canonicalIssueUrl(repository, issueNumber) {
  if (typeof repository !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new Error('repository must be an owner/name pair')
  }
  if (!Number.isSafeInteger(issueNumber) || issueNumber < 1) {
    throw new Error('baseline Issue number must be a positive integer')
  }
  return `https://github.com/${repository}/issues/${issueNumber}`
}

/** Return the immutable marker and English title that identify one DSH-created CI baseline Issue. */
export function baselineIssueIdentity({ workflowName, issueBody }) {
  if (typeof workflowName !== 'string' || workflowName.length < 1 || workflowName.length > 120
    || /[\r\n\u0000-\u001F\u007F]/.test(workflowName)) {
    throw new Error('CI workflow name is invalid for a baseline Issue')
  }
  const match = /^<!-- dsh-ci-baseline:v1:([0-9a-f]{16}) -->\r?\n/.exec(String(issueBody || ''))
  if (!match) throw new Error('Baseline Issue does not begin with the expected idempotency marker')
  const key = match[1]
  return {
    key,
    marker: match[0].trim(),
    title: `CI baseline: ${workflowName} [${key}]`,
  }
}

function isPlainRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
}

function exactKeys(value, expected, name) {
  if (!isPlainRecord(value)) throw new Error(`${name} must be an object`)
  const actual = Object.keys(value).sort()
  const sortedExpected = [...expected].sort()
  if (actual.length !== sortedExpected.length || actual.some((key, index) => key !== sortedExpected[index])) {
    throw new Error(`${name} has unexpected fields`)
  }
}

function boundedSummary(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 2_000
    || /[\u0000-\u001F\u007F]/.test(value)) {
    throw new Error('automationResult summary is invalid')
  }
}

/**
 * Accept only a DSH receipt that explicitly attests a CI failure already exists on
 * the supplied default-branch revision. The Issue reference is revalidated against
 * GitHub before it can alter controller state.
 */
export function ciBaselineIssueFromReceipt({ receipt, repository }) {
  if (receipt?.outcome !== 'blocked') return null
  const result = receipt.automationResult
  if (result?.blockedReason !== 'ci-baseline') return null
  exactKeys(result, ['version', 'outcome', 'summary', 'blockedReason', 'issue'], 'automationResult')
  if (result.version !== 1 || result.outcome !== 'blocked' || result.blockedReason !== 'ci-baseline') {
    throw new Error('automationResult is not a CI baseline block')
  }
  boundedSummary(result.summary)
  exactKeys(result.issue, ['number', 'url'], 'automationResult.issue')
  const number = result.issue.number
  const url = canonicalIssueUrl(repository, number)
  if (result.issue.url !== url) throw new Error('automationResult Issue URL is not canonical for this repository')
  return { number, url }
}

/** Accept a strict terminal DSH block that deliberately does not delegate a baseline Issue. */
export function nonBaselineBlockFromReceipt(receipt) {
  if (receipt?.outcome !== 'blocked') return null
  const result = receipt.automationResult
  exactKeys(result, ['version', 'outcome', 'summary', 'blockedReason'], 'automationResult')
  if (result.version !== 1 || result.outcome !== 'blocked'
    || !['cannot-complete', 'external'].includes(result.blockedReason)) {
    throw new Error('automationResult is not a non-baseline DSH block')
  }
  boundedSummary(result.summary)
  return { reason: result.blockedReason }
}

/** Verify that a referenced Issue is still a same-repository, privileged DSH work item. */
export function trustedBaselineIssue({ issue, repository, reference, trustedAssociation, workflowName, branch, pullRequestBody }) {
  if (!issue || issue.number !== reference.number) throw new Error('Baseline Issue number changed')
  if (issue.html_url !== reference.url || issue.html_url !== canonicalIssueUrl(repository, reference.number)) {
    throw new Error('Baseline Issue URL is not canonical for this repository')
  }
  if (issue.state !== 'open' || issue.pull_request) throw new Error('Baseline Issue is not an open Issue')
  if (!trustedAssociation(issue.author_association)) throw new Error('Baseline Issue author is not trusted')
  if (!Array.isArray(issue.labels) || !issue.labels.some(label => label?.name === 'agent/dsh')) {
    throw new Error('Baseline Issue is missing the exact agent/dsh label')
  }
  const identity = baselineIssueIdentity({ workflowName, issueBody: issue.body })
  if (issue.title !== identity.title) {
    throw new Error('Baseline Issue title does not match its idempotency marker')
  }
  if (branch === `agent/issue-${reference.number}`) {
    throw new Error('Baseline Issue cannot dispatch the pull request already implementing it')
  }
  if (new RegExp(`\\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\\s+#${reference.number}\\b`, 'i').test(String(pullRequestBody || ''))) {
    throw new Error('Baseline Issue cannot dispatch the pull request already declared to close it')
  }
  return { issue, identity }
}
