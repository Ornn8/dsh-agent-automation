const RESULT_MARKER = '<!-- repository-supervision-result\n'
const RESULT_TRAILER = '\n-->'
const RESULT_VERSION = 1
const ACTION_TYPES = new Set([
  'create_issue',
  'comment_issue',
  'comment_pr',
  'close_issue',
  'reopen_issue',
  'add_label',
  'remove_label',
])
const EVIDENCE_SOURCES = new Set([
  'master',
  'ci',
  'upstream',
  'pull_request',
  'merged_pull_request',
  'issue_state',
])
const REQUIRED_ISSUE_SECTIONS = [
  'Objective',
  'Scope',
  'Requirements',
  'Acceptance criteria',
  'Validation',
]
const NON_EXECUTABLE_LABELS = new Set([
  'tracker',
  'type/tracker',
  'research',
  'type/research',
  'informational',
  'type/informational',
  'duplicate',
])
const ACTIVE_RUN_STATUSES = new Set(['queued', 'in_progress', 'waiting', 'pending', 'requested'])

function exactKeys(value, expected) {
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index])
}

function objectValue(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${name} must be an object`)
  }
  return value
}

function positiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`)
  return value
}

export function englishText(value, name, limit, { multiline = true } = {}) {
  if (typeof value !== 'string' || !value.trim() || value.length > limit) {
    throw new Error(`${name} must be non-empty English text of at most ${limit} characters`)
  }
  const pattern = multiline ? /^[\x09\x0A\x0D\x20-\x7E]+$/ : /^[\x20-\x7E]+$/
  if (!pattern.test(value) || (!multiline && /[\r\n]/.test(value))) {
    throw new Error(`${name} must contain printable English ASCII only`)
  }
  return value
}

function fingerprint(value, name = 'fingerprint') {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9-]{2,79}$/.test(value)) {
    throw new Error(`${name} must be a lowercase kebab-case identifier of 3 to 80 characters`)
  }
  return value
}

function labelName(value, name = 'label') {
  englishText(value, name, 100, { multiline: false })
  if (!/^[A-Za-z0-9][A-Za-z0-9 /_.:+-]{0,99}$/.test(value)) {
    throw new Error(`${name} has an unsupported format`)
  }
  return value
}

function evidenceItem(value, index) {
  objectValue(value, `evidence[${index}]`)
  if (!EVIDENCE_SOURCES.has(value.source)) throw new Error(`evidence[${index}].source is unsupported`)
  const sourceEvidence = ['master', 'upstream', 'pull_request'].includes(value.source)
  const expected = sourceEvidence
    ? ['source', 'reference', 'excerpt', 'detail']
    : ['source', 'reference', 'detail']
  if (!exactKeys(value, expected)) {
    throw new Error(`evidence[${index}] has unexpected fields or is missing its source excerpt`)
  }
  englishText(value.reference, `evidence[${index}].reference`, 500, { multiline: false })
  englishText(value.detail, `evidence[${index}].detail`, 500, { multiline: false })
  if (sourceEvidence && (typeof value.excerpt !== 'string' || value.excerpt.length < 8
    || value.excerpt.length > 500 || /[\r\n\x00]/.test(value.excerpt))) {
    throw new Error(`evidence[${index}].excerpt must be an exact single-line source excerpt of 8 to 500 characters`)
  }
  return sourceEvidence
    ? { source: value.source, reference: value.reference, excerpt: value.excerpt, detail: value.detail }
    : { source: value.source, reference: value.reference, detail: value.detail }
}

function evidenceList(value, name = 'evidence') {
  if (!Array.isArray(value) || value.length < 1 || value.length > 5) {
    throw new Error(`${name} must contain one to five evidence items`)
  }
  return value.map(evidenceItem)
}

export function parseIssueDependencies(body) {
  const dependencies = []
  for (const line of String(body || '').split(/\r?\n/)) {
    const match = line.match(/^(Depends on|Blocked by) #(\d+)\.$/)
    if (!match) continue
    dependencies.push({ kind: match[1], number: Number.parseInt(match[2], 10) })
  }
  return dependencies
}

export function declaredBranch(body) {
  const matches = [...String(body || '').matchAll(/^Branch: `([^`\r\n]+)`$/gm)]
  if (matches.length !== 1) return ''
  return matches[0][1]
}

export function validateExecutableIssueBody(body, { requireEvidence = false } = {}) {
  englishText(body, 'Issue body', 30_000)
  const branch = declaredBranch(body)
  if (!/^agent\/[a-z0-9][a-z0-9-]{1,63}$/.test(branch)) {
    throw new Error('Executable Issue body must contain exactly one separate Branch: `agent/<short-topic>` line')
  }
  for (const section of REQUIRED_ISSUE_SECTIONS) {
    const matches = String(body).match(new RegExp(`^## ${section.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'gm')) || []
    if (matches.length !== 1) throw new Error(`Executable Issue body must contain exactly one ## ${section} section`)
  }
  if (requireEvidence && !/^## Evidence$/m.test(body)) {
    throw new Error('Supervisor-created executable Issue body must contain a ## Evidence section')
  }
  const malformedDependency = String(body).split(/\r?\n/).find(line => {
    if (!/^(?:Depends on|Blocked by)\b/.test(line)) return false
    return !/^(?:Depends on|Blocked by) #\d+\.$/.test(line)
  })
  if (malformedDependency) throw new Error(`Malformed dependency declaration: ${malformedDependency}`)
  return { branch, dependencies: parseIssueDependencies(body) }
}

export function nonExecutableIssueReasons(issue) {
  const title = String(issue?.title || '').trim()
  const labels = new Set((issue?.labels || []).map(label => String(label).toLowerCase()))
  const reasons = []
  if (/^\[(?:TRACKER|RESEARCH|INFO|INFORMATIONAL)\]/i.test(title)) reasons.push('the Issue is not executable work')
  if (/\bduplicate\b/i.test(title) || labels.has('duplicate')) reasons.push('the Issue is a duplicate')
  if ([...NON_EXECUTABLE_LABELS].some(label => labels.has(label))) reasons.push('the Issue classification is not executable')
  return [...new Set(reasons)]
}

function normalizeTitle(title) {
  return String(title || '')
    .toLowerCase()
    .replace(/^\[[^\]]+\]\s*/, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

const TITLE_STOP_WORDS = new Set(['bug', 'fix', 'issue', 'handling', 'support', 'update'])

function titleTokens(title) {
  const tokens = normalizeTitle(title).split(/\s+/)
    .map(token => token.length > 4 && token.endsWith('s') ? token.slice(0, -1) : token)
    .filter(token => token.length > 2 && !TITLE_STOP_WORDS.has(token))
  return new Set(tokens)
}

export function issueTitleSimilarity(left, right) {
  const a = titleTokens(left)
  const b = titleTokens(right)
  if (a.size === 0 || b.size === 0) {
    const rawLeft = String(left || '').trim().toLowerCase()
    const rawRight = String(right || '').trim().toLowerCase()
    return rawLeft && rawLeft === rawRight ? 1 : 0
  }
  let intersection = 0
  for (const token of a) if (b.has(token)) intersection += 1
  return intersection / (a.size + b.size - intersection)
}

function issueIndex(snapshot) {
  return new Map((snapshot?.issues || []).map(issue => [issue.number, issue]))
}

function pullRequestIndex(snapshot) {
  return new Map((snapshot?.pullRequests || []).map(pr => [pr.number, pr]))
}

function activeOwnershipReasons(issue, snapshot, branch) {
  const reasons = []
  if ((snapshot?.branches || []).some(candidate => candidate.name === branch)) {
    reasons.push(`remote branch ${branch} already exists`)
  }
  for (const pullRequest of snapshot?.pullRequests || []) {
    if (pullRequest.state !== 'open') continue
    const closesIssue = new RegExp(`\\bCloses\\s+#${issue.number}\\b`, 'i').test(String(pullRequest.body || ''))
    if (closesIssue || pullRequest.head?.ref === branch) {
      reasons.push(`open pull request #${pullRequest.number} already owns the work`)
    }
  }
  for (const run of snapshot?.runs || []) {
    if (run.headBranch === branch && ACTIVE_RUN_STATUSES.has(run.status)) {
      reasons.push(`active workflow run ${run.id} already owns branch ${branch}`)
    }
  }
  return reasons
}

function agentDshSafetyAssessment(issue, snapshot) {
  const reasons = nonExecutableIssueReasons(issue)
  if (issue?.state !== 'open') reasons.push('the Issue is not open')

  let specification
  try {
    specification = validateExecutableIssueBody(String(issue?.body || ''))
  } catch (error) {
    reasons.push(error.message)
  }

  const issues = issueIndex(snapshot)
  if (specification) {
    for (const dependency of specification.dependencies) {
      const dependencyIssue = issues.get(dependency.number)
      if (!dependencyIssue) reasons.push(`dependency #${dependency.number} is missing from the audited state`)
      else if (dependencyIssue.state !== 'closed') reasons.push(`dependency #${dependency.number} is still open`)
    }
  }
  return { specification, reasons: [...new Set(reasons)] }
}

/** Decide whether an existing trigger is structurally safe, ignoring work that it already started. */
export function agentDshTriggerSafety(issue, snapshot, repository = snapshot?.repository) {
  const assessment = agentDshSafetyAssessment(issue, snapshot)
  return { safe: assessment.reasons.length === 0, reasons: assessment.reasons }
}

/** Decide whether the controller may add a new immediate execution trigger now. */
export function agentDshEligibility(issue, snapshot, repository = snapshot?.repository) {
  const assessment = agentDshSafetyAssessment(issue, snapshot)
  const reasons = [...assessment.reasons]
  if (assessment.specification) {
    reasons.push(...activeOwnershipReasons(issue, snapshot, assessment.specification.branch))
  }
  return { eligible: reasons.length === 0, reasons: [...new Set(reasons)] }
}

function validatedAction(value, index) {
  objectValue(value, `actions[${index}]`)
  if (!Object.hasOwn(value, 'fingerprint')) value = { ...value, fingerprint: 'controller-derived' }
  if (!ACTION_TYPES.has(value.type)) throw new Error(`actions[${index}].type is unsupported`)
  const common = {
    type: value.type,
    evidence: evidenceList(value.evidence, `actions[${index}].evidence`),
  }
  if (value.type === 'create_issue') {
    if (!exactKeys(value, ['type', 'fingerprint', 'title', 'body', 'labels', 'evidence'])) {
      throw new Error(`actions[${index}] create_issue has unexpected fields`)
    }
    englishText(value.title, `actions[${index}].title`, 200, { multiline: false })
    const specification = validateExecutableIssueBody(value.body, { requireEvidence: true })
    if (nonExecutableIssueReasons({ title: value.title, labels: value.labels }).length > 0) {
      throw new Error(`actions[${index}] create_issue cannot create tracker, research, informational, or duplicate work`)
    }
    if (!Array.isArray(value.labels) || value.labels.length > 10) {
      throw new Error(`actions[${index}].labels must contain at most ten labels`)
    }
    const labels = value.labels.map((label, labelIndex) => labelName(label, `actions[${index}].labels[${labelIndex}]`))
    if (new Set(labels).size !== labels.length) throw new Error(`actions[${index}].labels must not contain duplicates`)
    if (labels.includes('agent/dsh')) throw new Error('A newly created Issue cannot receive agent/dsh in the same supervision run')
    return { ...common, title: value.title, body: value.body, labels, specification }
  }

  if (['comment_issue', 'comment_pr'].includes(value.type)) {
    if (!exactKeys(value, ['type', 'number', 'fingerprint', 'body', 'evidence'])) {
      throw new Error(`actions[${index}] ${value.type} has unexpected fields`)
    }
    return {
      ...common,
      number: positiveInteger(value.number, `actions[${index}].number`),
      body: englishText(value.body, `actions[${index}].body`, 10_000),
    }
  }

  if (value.type === 'close_issue') {
    const expected = value.reason === 'duplicate'
      ? ['type', 'number', 'fingerprint', 'reason', 'duplicateOf', 'evidence']
      : ['type', 'number', 'fingerprint', 'reason', 'evidence']
    if (!exactKeys(value, expected)) throw new Error(`actions[${index}] close_issue has unexpected fields`)
    if (!['completed', 'duplicate'].includes(value.reason)) throw new Error(`actions[${index}].reason is unsupported`)
    const action = {
      ...common,
      number: positiveInteger(value.number, `actions[${index}].number`),
      reason: value.reason,
    }
    if (value.reason === 'duplicate') {
      action.duplicateOf = positiveInteger(value.duplicateOf, `actions[${index}].duplicateOf`)
      if (action.duplicateOf === action.number) throw new Error('An Issue cannot be a duplicate of itself')
    }
    return action
  }

  if (value.type === 'reopen_issue') {
    if (!exactKeys(value, ['type', 'number', 'fingerprint', 'evidence'])) {
      throw new Error(`actions[${index}] reopen_issue has unexpected fields`)
    }
    return { ...common, number: positiveInteger(value.number, `actions[${index}].number`) }
  }

  if (!exactKeys(value, ['type', 'number', 'fingerprint', 'label', 'evidence'])) {
    throw new Error(`actions[${index}] ${value.type} has unexpected fields`)
  }
  return {
    ...common,
    number: positiveInteger(value.number, `actions[${index}].number`),
    label: labelName(value.label, `actions[${index}].label`),
  }
}

export function validateSupervisionProposal(value) {
  objectValue(value, 'Repository supervision result')
  if (!exactKeys(value, ['version', 'summary', 'actions']) || value.version !== RESULT_VERSION) {
    throw new Error('Repository supervision result has an invalid version or fields')
  }
  const summary = englishText(value.summary, 'Repository supervision summary', 500, { multiline: false })
  if (!Array.isArray(value.actions) || value.actions.length > 5) {
    throw new Error('Repository supervision result must contain at most five actions')
  }
  const actions = value.actions.map(validatedAction).map(action => ({
    ...action,
    fingerprint: controllerActionFingerprint(action),
  }))
  if (actions.filter(action => action.type === 'create_issue').length > 1) {
    throw new Error('Repository supervision may create at most one Issue per run')
  }
  const fingerprints = actions.map(action => action.fingerprint)
  if (new Set(fingerprints).size !== fingerprints.length) {
    throw new Error('Repository supervision action fingerprints must be unique')
  }
  return { version: RESULT_VERSION, summary, actions }
}

/** Return deterministic cleanup actions for unsafe or partially cleaned Agent Issue triggers. */
export function mandatoryBlockedCorrections(snapshot, repository = snapshot?.repository) {
  const actions = []
  for (const issue of snapshot.issues) {
    const safety = agentDshTriggerSafety(issue, snapshot, repository)
    if (safety.safe) continue
    const reasonHash = createHash('sha256').update(safety.reasons.join('\n')).digest('hex').slice(0, 12)
    const details = safety.reasons.join('; ').replace(/[\r\n]/g, ' ').slice(0, 500)
    const blockedText = `BLOCKED: Issue #${issue.number} cannot execute now because ${details}. The assigned change agent must stop, create no commit, push no branch, open no pull request, and discard temporary work.`
    const alreadyCommented = (issue.comments || []).some(comment => String(comment.body || '').includes(blockedText))
    if (issue.labels.includes('agent/dsh')) {
      actions.push({
        type: 'remove_label', number: issue.number, label: 'agent/dsh',
        fingerprint: `blocked-agent-dsh-${issue.number}-${reasonHash}`,
        evidence: [{ source: 'issue_state', reference: `#${issue.number}`, detail: details }],
      })
    } else if (!alreadyCommented) {
      actions.push({
        type: 'comment_issue', number: issue.number,
        fingerprint: `blocked-agent-dsh-comment-${issue.number}-${reasonHash}`,
        body: blockedText,
        evidence: [{ source: 'issue_state', reference: `#${issue.number}`, detail: details }],
      })
    }
  }
  return actions
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

/** Return the controller-owned idempotency key for one validated action. */
export function controllerActionFingerprint(action) {
  const normalized = Object.fromEntries(Object.entries(action).filter(([key]) => key !== 'fingerprint'))
  const digest = createHash('sha256').update(canonicalJson(normalized)).digest('hex').slice(0, 20)
  return `${String(action.type).replace(/_/g, '-')}-${digest}`
}

export function parseSupervisionMessage(message) {
  if (typeof message !== 'string') throw new Error('Repository supervisor final message must be text')
  const markerAt = message.lastIndexOf(RESULT_MARKER)
  if (markerAt < 0 || markerAt !== message.indexOf(RESULT_MARKER) || !message.endsWith(RESULT_TRAILER)) {
    throw new Error('Repository supervisor final message must end with exactly one repository supervision result')
  }
  const encoded = message.slice(markerAt + RESULT_MARKER.length, -RESULT_TRAILER.length)
  let value
  try {
    value = JSON.parse(encoded)
  } catch (error) {
    throw new Error(`Repository supervision result is not valid JSON: ${error.message}`, { cause: error })
  }
  return validateSupervisionProposal(value)
}

function actionMarker(action) {
  return `<!-- repository-supervision:${action.fingerprint} -->`
}

function allMarkerText(snapshot) {
  const values = []
  for (const issue of snapshot?.issues || []) {
    values.push(issue.body || '')
    for (const comment of issue.comments || []) values.push(comment.body || '')
  }
  for (const pr of snapshot?.pullRequests || []) {
    values.push(pr.body || '')
    for (const comment of pr.comments || []) values.push(comment.body || '')
  }
  return values.join('\n')
}

export function planSupervisionActions(proposal, snapshot, {
  repository = snapshot?.repository,
  maxMutations = 5,
} = {}) {
  const issues = issueIndex(snapshot)
  const pullRequests = pullRequestIndex(snapshot)
  const labels = new Set(snapshot?.labels || [])
  const existingMarkers = allMarkerText(snapshot)
  const planned = []
  let mutationCount = 0

  for (const action of proposal.actions) {
    const marker = actionMarker(action)
    const markerExists = existingMarkers.includes(marker)
    if (markerExists && !(action.type === 'remove_label' && action.label === 'agent/dsh')) continue

    if (action.type === 'create_issue') {
      if (action.labels.some(label => !labels.has(label))) {
        throw new Error(`create_issue references an unknown label: ${action.labels.find(label => !labels.has(label))}`)
      }
      for (const issue of snapshot?.issues || []) {
        if (issueTitleSimilarity(action.title, issue.title) >= 0.72) {
          throw new Error(`create_issue duplicates or substantially overlaps Issue #${issue.number}`)
        }
      }
      planned.push({ ...action, marker })
      mutationCount += 1
      continue
    }

    if (action.type === 'comment_issue') {
      const issue = issues.get(action.number)
      if (!issue) throw new Error(`comment_issue targets unknown Issue #${action.number}`)
      planned.push({ ...action, marker })
      mutationCount += 1
      continue
    }

    if (action.type === 'comment_pr') {
      const pullRequest = pullRequests.get(action.number)
      if (!pullRequest) throw new Error(`comment_pr targets unknown pull request #${action.number}`)
      if (pullRequest.state !== 'open') throw new Error(`comment_pr targets closed pull request #${action.number}`)
      planned.push({ ...action, marker })
      mutationCount += 1
      continue
    }

    const issue = issues.get(action.number)
    if (!issue) throw new Error(`${action.type} targets unknown Issue #${action.number}`)

    if (action.type === 'close_issue') {
      if (issue.state === 'closed') continue
      if (action.reason === 'duplicate' && !issues.get(action.duplicateOf)) {
        throw new Error(`close_issue duplicate target #${action.duplicateOf} is unknown`)
      }
      planned.push({ ...action, marker })
      mutationCount += 1
      continue
    }

    if (action.type === 'reopen_issue') {
      if (issue.state === 'open') continue
      planned.push({ ...action, marker })
      mutationCount += 1
      continue
    }

    const issueLabels = new Set(issue.labels || [])
    if (!labels.has(action.label)) throw new Error(`${action.type} references unknown label ${action.label}`)

    if (action.type === 'add_label') {
      if (issueLabels.has(action.label)) continue
      if (action.label === 'agent/dsh') {
        const eligibility = agentDshEligibility(issue, snapshot, repository)
        if (!eligibility.eligible) {
          throw new Error(`agent/dsh is unsafe for Issue #${issue.number}: ${eligibility.reasons.join('; ')}`)
        }
      }
      planned.push({ ...action, marker })
      mutationCount += 1
      continue
    }

    if (!issueLabels.has(action.label)) continue
    if (action.label === 'agent/dsh') {
      const safety = agentDshTriggerSafety(issue, snapshot, repository)
      if (safety.safe) {
        throw new Error(`remove_label cannot remove agent/dsh from structurally ready Issue #${issue.number} without a blocking reason`)
      }
      planned.push({ ...action, marker, blockingReasons: safety.reasons, commentRequired: !markerExists })
      mutationCount += markerExists ? 1 : 2
    } else {
      planned.push({ ...action, marker })
      mutationCount += 1
    }
  }

  if (!Number.isSafeInteger(maxMutations) || maxMutations < 1 || maxMutations > 5) {
    throw new Error('maxMutations must be an integer from 1 to 5')
  }
  if (mutationCount > maxMutations) {
    throw new Error(`Repository supervision proposed ${mutationCount} GitHub mutations, exceeding the ${maxMutations} mutation limit`)
  }
  return { actions: planned, mutationCount }
}

export function supervisionMarker(fingerprintValue) {
  return `<!-- repository-supervision:${fingerprint(fingerprintValue)} -->`
}
import { createHash } from 'node:crypto'
