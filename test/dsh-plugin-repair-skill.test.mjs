import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const repairSkill = await readFile(new URL('../dsh-plugin/skills/repair.md', import.meta.url), 'utf8')
const issueSkill = await readFile(new URL('../dsh-plugin/skills/issue.md', import.meta.url), 'utf8')
const pluginReadme = await readFile(new URL('../dsh-plugin/README.md', import.meta.url), 'utf8')

function examples(source) {
  return [...source.matchAll(/<!-- agent-automation-result\r?\n(\{[^\r\n]+\})\r?\n-->/g)].map(match => JSON.parse(match[1]))
}

test('repair Skill hands a proven CI baseline failure to a same-repository Issue', () => {
  assert.match(repairSkill, /at most one same-head rebuttal/)
  assert.match(repairSkill, /must not request another same-head review/)
  assert.match(repairSkill, /same named workflow fails on the current `defaultBranch` commit/)
  assert.match(repairSkill, /Search open, non-pull-request Issues in the same repository/)
  assert.match(repairSkill, /`<!-- dsh-ci-baseline:v1:<baselineKey> -->`/)
  assert.match(repairSkill, /`CI baseline: <workflowName> \[<baselineKey>\]`/)
  assert.match(repairSkill, /first 16 lowercase hexadecimal characters of SHA-256/)
  assert.match(repairSkill, /Do not add `agent\/dsh` or another execution label/)
  assert.match(repairSkill, /later independent Controller observation and attested admission/)
  assert.match(repairSkill, /open unlabeled Issue number and URL have been re-read from GitHub/)
  assert.match(repairSkill, /must not dispatch the same Issue again/)
  assert.match(repairSkill, /return `cannot-complete` without an `issue` property/)
  assert.match(repairSkill, /Do not create an Issue for a pull-request defect, inconclusive CI evidence, review feedback, or a non-CI external blocker/)
  assert.match(repairSkill, /pull request comment, Issue label, or local receipt must not authorize or route the new work/)
  assert.match(repairSkill, /Do not report it as `ci-baseline`/)
})

test('repair Skill defines one hidden, authorization-free completion receipt', () => {
  assert.match(repairSkill, /concise Chinese report followed by exactly one hidden local automation receipt/)
  assert.match(repairSkill, /`<!-- agent-automation-result`, then one strict JSON object on its own line, then `-->/)
  const [completed, baseline, external, cannotComplete] = examples(repairSkill)
  assert.deepEqual(completed, { version: 1, outcome: 'completed', summary: '已推进 PR 新提交或已请求同一提交复审。' })
  assert.equal(baseline.outcome, 'blocked')
  assert.equal(baseline.blockedReason, 'ci-baseline')
  assert.deepEqual(baseline.issue, { number: 456, url: 'https://github.com/owner/repository/issues/456' })
  assert.deepEqual(external, { version: 1, outcome: 'blocked', blockedReason: 'external', summary: '外部服务不可用，无法在本会话中安全完成。' })
  assert.deepEqual(cannotComplete, { version: 1, outcome: 'blocked', blockedReason: 'cannot-complete', summary: '当前 PR 已在实现该基线 Issue，不能再次派发同一 Issue。' })
  assert.match(repairSkill, /`issue\.number` must be the re-read positive integer Issue number/)
  assert.match(repairSkill, /`blockedReason: "external"`, and `blockedReason: "cannot-complete"`, the JSON object must not contain `issue`/)
  assert.match(repairSkill, /`summary` is a concise Chinese session report/)
})

test('Issue Skill owns its terminal receipt instead of relying on controller prompt prose', () => {
  const [completed, external, cannotComplete] = examples(issueSkill)
  assert.equal(completed.outcome, 'completed')
  assert.equal(external.blockedReason, 'external')
  assert.equal(cannotComplete.blockedReason, 'cannot-complete')
  assert.match(issueSkill, /concise Chinese report followed by exactly one hidden local automation receipt/)
})

test('plugin documentation keeps the receipt separate from authorization', () => {
  assert.match(pluginReadme, /final hidden `agent-automation-result` JSON receipt/)
  assert.match(pluginReadme, /same-repository Issue/)
  assert.match(pluginReadme, /deterministic `dsh-ci-baseline:v1` body marker/)
  assert.match(pluginReadme, /not an authorization grant/)
  assert.match(pluginReadme, /GitHub comments remain audit records rather than a routing or authorization channel/)
  assert.match(pluginReadme, /Completed, `cannot-complete`, and `external` receipts do not contain an Issue/)
})
