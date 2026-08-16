export const AGENT_ISSUE_SKILL = 'github-issue-work'
export const AGENT_REPAIR_SKILL = 'github-pr-repair'
export const AGENT_REVIEW_SKILL = 'github-pr-review'
export const AGENT_SUPERVISION_SKILL = 'github-repository-supervision'
export const AGENT_READINESS_SKILL = 'agent-readiness-canary'
export const AGENT_MAINTENANCE_SKILL = 'controller-maintenance-repair'

const AGENT_SKILLS = new Map([
  [AGENT_ISSUE_SKILL, {
    source: new URL('../dsh-plugin/skills/issue.md', import.meta.url),
    description: 'Implement one controller-routed GitHub Issue and publish its pull request.',
  }],
  [AGENT_REPAIR_SKILL, {
    source: new URL('../dsh-plugin/skills/repair.md', import.meta.url),
    description: 'Repair one controller-routed GitHub pull request and publish its updated head.',
  }],
  [AGENT_REVIEW_SKILL, {
    source: new URL('../dsh-plugin/skills/review.md', import.meta.url),
    description: 'Review one exact pull request base and head without changing or executing it.',
  }],
  [AGENT_SUPERVISION_SKILL, {
    source: new URL('../dsh-plugin/skills/supervise.md', import.meta.url),
    description: 'Audit one exact repository state and propose bounded policy-validated GitHub management actions.',
  }],
  [AGENT_READINESS_SKILL, {
    source: new URL('../dsh-plugin/skills/readiness.md', import.meta.url),
    description: 'Verify one configured Agent and provider with no repository or GitHub mutation.',
  }],
  [AGENT_MAINTENANCE_SKILL, {
    source: new URL('../dsh-plugin/skills/maintenance.md', import.meta.url),
    description: 'Repair one attested root fault in the Controller or Operations repository.',
  }],
])

const AUTOMATION_RESULT_VERSION = 1
const AUTOMATION_RESULT_OUTCOMES = new Set(['completed', 'blocked'])
const AUTOMATION_RESULT_BLOCKED_REASONS = new Set(['cannot-complete', 'external', 'ci-baseline'])
const AUTOMATION_RESULT_MARKER = '<!-- agent-automation-result\n'
const AUTOMATION_RESULT_TRAILER = '\n-->'
const MAX_AUTOMATION_RESULT_SUMMARY_LENGTH = 500

/** Resolve one controller-owned Agent Skill independently of its runtime adapter. */
export function agentSkillDefinition(skillName) {
  const skill = AGENT_SKILLS.get(skillName)
  if (!skill) throw new Error(`Unknown Agent Skill: ${skillName}`)
  return skill
}

function ownKeys(value) {
  return Object.keys(value).sort()
}

function exactlyKeys(value, keys) {
  const actual = ownKeys(value)
  const expected = [...keys].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

function resultSummary(value, field = 'summary') {
  if (typeof value !== 'string' || !value.trim()
    || value.length > MAX_AUTOMATION_RESULT_SUMMARY_LENGTH
    || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`Agent automation result ${field} must be one non-empty single-line string of at most ${MAX_AUTOMATION_RESULT_SUMMARY_LENGTH} characters`)
  }
  return value
}

function baselineIssue(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !exactlyKeys(value, ['number', 'url'])
    || !Number.isSafeInteger(value.number) || value.number < 1
    || typeof value.url !== 'string') {
    throw new Error('DSH CI baseline result must declare one Issue number and URL')
  }
  let url
  try {
    url = new URL(value.url)
  } catch {
    throw new Error('DSH CI baseline Issue URL must be canonical GitHub HTTPS')
  }
  if (value.url !== url.href || url.protocol !== 'https:' || url.hostname !== 'github.com'
    || url.username || url.password || url.port || url.search || url.hash
    || !new RegExp(`^/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/issues/${value.number}$`).test(url.pathname)) {
    throw new Error('DSH CI baseline Issue URL must be canonical GitHub HTTPS')
  }
  return { number: value.number, url: url.href }
}

/** Parse the terminal machine receipt embedded at the end of one Agent final message. */
export function parseAgentAutomationResult(finalMessage) {
  if (typeof finalMessage !== 'string') throw new Error('Agent final assistant message must be text')
  const markerAt = finalMessage.lastIndexOf(AUTOMATION_RESULT_MARKER)
  if (markerAt < 0 || markerAt !== finalMessage.indexOf(AUTOMATION_RESULT_MARKER)
    || !finalMessage.endsWith(AUTOMATION_RESULT_TRAILER)) {
    throw new Error('Agent final assistant message must end with the automation result')
  }
  const encoded = finalMessage.slice(markerAt + AUTOMATION_RESULT_MARKER.length, -AUTOMATION_RESULT_TRAILER.length)
  let value
  try {
    value = JSON.parse(encoded)
  } catch (error) {
    throw new Error(`Agent automation result is not valid JSON: ${error.message}`, { cause: error })
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.version !== AUTOMATION_RESULT_VERSION
    || !AUTOMATION_RESULT_OUTCOMES.has(value.outcome)) {
    throw new Error('Agent automation result has an invalid version or outcome')
  }
  const summary = resultSummary(value.summary)
  if (value.outcome === 'completed') {
    if (!exactlyKeys(value, ['version', 'outcome', 'summary'])) {
      throw new Error('Completed Agent automation result has unexpected fields')
    }
    return { version: AUTOMATION_RESULT_VERSION, outcome: 'completed', summary }
  }
  if (!AUTOMATION_RESULT_BLOCKED_REASONS.has(value.blockedReason)) {
    throw new Error('Blocked Agent automation result has an invalid blockedReason')
  }
  if (value.blockedReason === 'cannot-complete' || value.blockedReason === 'external') {
    if (!exactlyKeys(value, ['version', 'outcome', 'summary', 'blockedReason'])) {
      throw new Error('Non-CI blocked Agent automation result has unexpected fields')
    }
    return { version: AUTOMATION_RESULT_VERSION, outcome: 'blocked', summary, blockedReason: value.blockedReason }
  }
  if (!exactlyKeys(value, ['version', 'outcome', 'summary', 'blockedReason', 'issue'])) {
    throw new Error('CI baseline Agent automation result has unexpected fields')
  }
  return {
    version: AUTOMATION_RESULT_VERSION,
    outcome: 'blocked',
    summary,
    blockedReason: 'ci-baseline',
    issue: baselineIssue(value.issue),
  }
}

/** Render one structured WorkRequest as a user-explicit Agent Skill invocation. */
export function agentWorkPrompt(skillName, workRequest) {
  try {
    agentSkillDefinition(skillName)
  } catch {
    throw new Error(`Unknown agent work skill: ${skillName}`)
  }
  if (!workRequest || typeof workRequest !== 'object' || Array.isArray(workRequest)) {
    throw new Error('Agent WorkRequest must be an object')
  }
  return `/${skillName} ${JSON.stringify(workRequest)}`
}
