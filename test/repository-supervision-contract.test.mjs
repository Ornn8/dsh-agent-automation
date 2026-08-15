import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import {
  AGENT_SUPERVISION_SKILL,
  agentSkillDefinition,
} from '../src/agent-work-result.mjs'

test('defines repository supervision as a controller-owned audit protocol', async () => {
  assert.equal(AGENT_SUPERVISION_SKILL, 'github-repository-supervision')
  const skill = agentSkillDefinition(AGENT_SUPERVISION_SKILL)
  assert.match(skill.description, /Audit one exact repository state/)
  assert.match(await readFile(skill.source, 'utf8'), /repository-supervision-result/)

  const plugin = await readFile(new URL('../dsh-plugin/index.js', import.meta.url), 'utf8')
  assert.doesNotMatch(plugin, /github-repository-supervision/)
  const controller = await readFile(new URL('../src/repository-supervisor.mjs', import.meta.url), 'utf8')
  assert.match(controller, /worker\?\.adapter !== 'codex-app'/)
})

test('reusable workflow isolates the model and bounds target writes', async () => {
  const workflow = await readFile(new URL('../.github/workflows/repository-supervisor.yml', import.meta.url), 'utf8')
  assert.match(workflow, /workflow_call:/)
  assert.match(workflow, /runs-on: \[self-hosted, agent-reviewer\]/)
  assert.match(workflow, /contents: read/)
  assert.match(workflow, /issues: write/)
  assert.match(workflow, /pull-requests: write/)
  assert.match(workflow, /persist-credentials: false/g)
  assert.match(workflow, /MAX_MUTATIONS: \$\{\{ inputs\.max_mutations \}\}/)
  assert.doesNotMatch(workflow, /pull_request_review/)
})

test('repository supervision revalidates live state after the model audit', async () => {
  const controller = await readFile(new URL('../src/repository-supervisor.mjs', import.meta.url), 'utf8')
  assert.equal((controller.match(/await readSnapshot\(\)/g) || []).length, 2)
  assert.match(controller, /assertAuditedHeadsStillCurrent\(auditedSnapshot, liveSnapshot\)/)
  assert.match(controller, /assertCommentTargetsStillCurrent\(modelProposal, auditedSnapshot, liveSnapshot\)/)
  assert.match(controller, /mandatoryBlockedCorrections\(liveSnapshot\)/)
  assert.match(controller, /planSupervisionActions\(proposal, liveSnapshot/)
  assert.match(controller, /snapshot: liveSnapshot/)
})

test('snapshot collection uses full upstream history and stable exact Issue and pull request pairs', async () => {
  const snapshot = await readFile(new URL('../src/supervision-snapshot.mjs', import.meta.url), 'utf8')
  assert.doesNotMatch(snapshot, /--depth/)
  assert.match(snapshot, /--no-recurse-submodules/)
  assert.match(snapshot, /issues\?state=open&per_page=100/)
  assert.match(snapshot, /pulls\?state=open&per_page=100/)
  assert.match(snapshot, /assertStableIssue\(before, after\)/)
  assert.match(snapshot, /pulls\/\$\{number\}\/comments\?per_page=100/)
  assert.match(snapshot, /assertStablePullRequest\(before, after\)/)
  assert.match(snapshot, /Issue #\$\{before\.number\} changed/)
  assert.match(snapshot, /Pull request #\$\{before\.number\} changed/)
  assert.match(snapshot, /finalTargetBranch\.commit\.sha !== targetBranch\.commit\.sha/)
  assert.match(snapshot, /finalUpstreamBranch\.commit\.sha !== upstreamBranch\.commit\.sha/)
})

test('operations documentation provides dry-run rollout and an offset six-hour schedule', async () => {
  const documentation = await readFile(new URL('../docs/repository-supervision.md', import.meta.url), 'utf8')
  assert.match(documentation, /17 \*\/6 \* \* \*/)
  assert.match(documentation, /apply_changes: false/)
  assert.match(documentation, /full commit SHA/)
  assert.match(documentation, /disable the target workflow/)
})
