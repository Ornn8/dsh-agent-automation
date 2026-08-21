import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import {
  createStartedGovernorRecord,
  governorBudgetDecision,
  governorDecision,
  governorRecordBody,
  parseGovernorRecord,
  rolloutDecision,
  subjectStateVersion,
  unappliedGovernorCandidate,
  workflowStageTransition,
} from '../src/governor-policy.mjs'
import {
  attestedGovernorRecordBody,
  trustedGovernorRecords,
} from '../src/governor-state.mjs'
import { ciRepairTransition } from '../src/dispatch-policy.mjs'
import { reviewRepairTransition } from '../src/work-request.mjs'

const issue = {
  type: 'issue',
  number: 44,
  state: 'open',
  updatedAt: '2026-08-16T12:00:00Z',
  title: 'Add governor controls',
  body: 'Branch: `agent/governor-control-plane`',
  labels: [],
}

test('one started Governor record atomically binds admitted routing and budget attempt', () => {
  const subject = {
    type: 'pull-request', number: 44, state: 'open', draft: false,
    base: 'a'.repeat(40), head: 'b'.repeat(40), labels: [],
  }
  const stateVersion = subjectStateVersion(subject)
  const candidate = governorDecision({
    transition: 'ci-repair:run-1', subject, stateVersion,
    observationId: 'run-1:1', records: [],
  }).record
  const admitted = governorDecision({
    transition: 'ci-repair:run-1', subject, stateVersion,
    observationId: 'run-2:1', records: [candidate],
  })
  const budget = governorBudgetDecision({
    transition: 'ci-repair', subject: { type: subject.type, number: subject.number },
    workIdentity: 'branch:agent/fix', observationId: 'run-2:1', limit: 3, records: [],
  })
  const started = createStartedGovernorRecord({
    admittedRecord: admitted.record,
    attemptRecord: budget.record,
  })

  assert.deepEqual(started, {
    version: 1,
    status: 'started',
    transition: 'ci-repair:run-1',
    subject: { type: 'pull-request', number: 44 },
    stateVersion,
    observationId: 'run-2:1',
    candidateObservationId: 'run-1:1',
    budgetTransition: 'ci-repair',
    workIdentity: 'branch:agent/fix',
    attempt: 1,
  })
  assert.deepEqual(parseGovernorRecord(governorRecordBody(started)), started)
  assert.equal(governorDecision({
    transition: 'ci-repair:run-1', subject, stateVersion,
    observationId: 'run-3:1', records: [candidate, started],
  }).action, 'noop')
  assert.deepEqual(governorBudgetDecision({
    transition: 'ci-repair', subject: { type: subject.type, number: subject.number },
    workIdentity: 'branch:agent/fix', observationId: 'run-2:1', limit: 3, records: [started],
  }), { action: 'noop', execute: false, reason: 'attempt-already-recorded' })
  assert.equal(governorBudgetDecision({
    transition: 'ci-repair', subject: { type: subject.type, number: subject.number },
    workIdentity: 'branch:agent/fix', observationId: 'run-3:1', limit: 3, records: [started],
  }).record.attempt, 2)
  assert.equal(unappliedGovernorCandidate([candidate, started], () => true), undefined)
  assert.throws(() => createStartedGovernorRecord({
    admittedRecord: admitted.record,
    attemptRecord: { ...budget.record, observationId: 'different-observation' },
  }), /observation/)
})

test('Workflow Stage transition identity changes with Profile content or Stage', () => {
  const first = workflowStageTransition({
    definitionHash: 'a'.repeat(64), workflowId: 'default', stageId: 'change',
  })
  assert.equal(first, `stage:${'a'.repeat(64)}:default:change`)
  assert.notEqual(first, workflowStageTransition({
    definitionHash: 'b'.repeat(64), workflowId: 'default', stageId: 'change',
  }))
  assert.notEqual(first, workflowStageTransition({
    definitionHash: 'a'.repeat(64), workflowId: 'default', stageId: 'review',
  }))
})

test('new work requires an independent later observation before admission', () => {
  const stateVersion = subjectStateVersion(issue)
  const proposed = governorDecision({
    transition: 'issue-dispatch',
    subject: issue,
    stateVersion,
    observationId: 'run-100',
    records: [],
  })

  assert.equal(proposed.action, 'record-candidate')
  assert.equal(proposed.execute, false)

  const admitted = governorDecision({
    transition: 'issue-dispatch',
    subject: issue,
    stateVersion,
    observationId: 'run-101',
    records: [proposed.record],
  })

  assert.equal(admitted.action, 'admit')
  assert.equal(admitted.execute, true)
})

test('an applied transition removes its durable candidate from pending reconciliation', () => {
  const stateVersion = 'a'.repeat(64)
  const candidate = {
    version: 1, status: 'candidate', transition: 'workflow-recovery',
    subject: { type: 'pull-request', number: 21 }, stateVersion, observationId: 'source-run-1',
  }
  const applied = {
    version: 1, status: 'applied', transition: 'workflow-recovery',
    subject: { type: 'pull-request', number: 21 }, stateVersion, observationId: 'recovery-run-2',
  }
  assert.equal(unappliedGovernorCandidate([candidate], () => true), candidate)
  assert.equal(unappliedGovernorCandidate([{ ...candidate, status: 'admitted' }], () => true).status, 'admitted')
  assert.equal(unappliedGovernorCandidate([candidate, applied], () => true), undefined)
})

test('an applied transition is a no-op for the same semantic state despite prose changes', () => {
  const stateVersion = subjectStateVersion(issue)
  const record = {
    version: 1,
    status: 'applied',
    transition: 'issue-dispatch',
    subject: { type: 'issue', number: 44 },
    stateVersion,
    observationId: 'run-101',
  }
  const parsed = parseGovernorRecord(governorRecordBody(record))
  assert.deepEqual(parsed, record)
  assert.deepEqual(governorDecision({
    transition: 'issue-dispatch',
    subject: { ...issue, updatedAt: '2026-08-16T13:00:00Z' },
    stateVersion,
    observationId: 'run-102',
    records: [parsed],
  }), {
    action: 'noop',
    execute: false,
    reason: 'transition-already-applied',
  })
})

test('paused work stays inert until an authorized resume is durably observed', () => {
  const stateVersion = subjectStateVersion(issue)
  const paused = {
    version: 1,
    status: 'paused',
    transition: 'review-repair',
    subject: { type: 'issue', number: 44 },
    stateVersion,
    observationId: 'run-200',
    reason: 'budget-exhausted',
  }
  const appliedBeforePause = {
    version: 1,
    status: 'applied',
    transition: 'issue-dispatch',
    subject: { type: 'issue', number: 44 },
    stateVersion,
    observationId: 'run-199',
  }
  assert.equal(governorDecision({
    transition: 'issue-dispatch', subject: issue, stateVersion,
    observationId: 'run-201', records: [appliedBeforePause, paused],
  }).action, 'paused')

  const resume = governorDecision({
    transition: 'issue-dispatch', subject: issue, stateVersion,
    observationId: 'run-202', records: [appliedBeforePause, paused],
    resumeCondition: { authorized: true, commandId: 'comment-900' },
  })
  assert.equal(resume.action, 'record-resume')
  assert.equal(resume.execute, false)

  const afterResume = governorDecision({
    transition: 'issue-dispatch', subject: issue, stateVersion,
    observationId: 'run-203', records: [appliedBeforePause, paused, resume.record],
  })
  assert.equal(afterResume.action, 'record-candidate')
})

test('independent subject repair budgets survive controller upgrades', () => {
  const attempts = [1, 2].map((attempt) => ({
    version: 1,
    status: 'attempt',
    transition: 'review-repair',
    subject: { type: 'pull-request', number: 9 },
    workIdentity: 'branch:agent/fix',
    attempt,
    observationId: `controller-${attempt}`,
  }))
  const decision = governorBudgetDecision({
    transition: 'review-repair',
    subject: { type: 'pull-request', number: 9 },
    workIdentity: 'branch:agent/fix',
    observationId: 'new-controller-run',
    limit: 2,
    records: attempts,
  })
  assert.equal(decision.action, 'pause')
  assert.equal(decision.record.reason, 'budget-exhausted')

  const ci = governorBudgetDecision({
    transition: 'ci-repair',
    subject: { type: 'pull-request', number: 9 },
    workIdentity: 'branch:agent/fix',
    observationId: 'new-controller-run',
    limit: 2,
    records: attempts,
  })
  assert.equal(ci.action, 'attempt')
  assert.equal(ci.record.attempt, 1)
})

test('same-head review generations admit independently but share one repair budget', () => {
  const pullRequest = {
    type: 'pull-request', number: 10, state: 'open', draft: false,
    base: 'a'.repeat(40), head: 'b'.repeat(40), labels: [],
  }
  const stateVersion = subjectStateVersion(pullRequest)
  const firstTransition = reviewRepairTransition('run-100')
  const secondTransition = reviewRepairTransition('run-200')
  const firstCandidate = governorDecision({
    transition: firstTransition, subject: pullRequest, stateVersion,
    observationId: 'run-100', records: [],
  }).record
  const firstAdmission = governorDecision({
    transition: firstTransition, subject: pullRequest, stateVersion,
    observationId: 'reconcile-101', records: [firstCandidate],
  })
  assert.equal(firstAdmission.action, 'admit')
  const firstApplied = {
    version: 1, status: 'applied', transition: firstTransition,
    subject: { type: 'pull-request', number: 10 }, stateVersion,
    observationId: 'reconcile-101',
  }
  const secondCandidate = governorDecision({
    transition: secondTransition, subject: pullRequest, stateVersion,
    observationId: 'run-200', records: [firstCandidate, firstAdmission.record, firstApplied],
  })
  assert.equal(secondCandidate.action, 'record-candidate')

  const firstBudget = governorBudgetDecision({
    transition: 'review-repair', subject: { type: 'pull-request', number: 10 },
    workIdentity: 'branch:agent/issue-1', observationId: 'reconcile-101', limit: 2, records: [],
  })
  const secondBudget = governorBudgetDecision({
    transition: 'review-repair', subject: { type: 'pull-request', number: 10 },
    workIdentity: 'branch:agent/issue-1', observationId: 'reconcile-201', limit: 2,
    records: [firstBudget.record],
  })
  assert.equal(firstBudget.record.attempt, 1)
  assert.equal(secondBudget.record.attempt, 2)
})

test('CI workflow runs admit independently while rerun attempts share one transition and budget', () => {
  const pullRequest = {
    type: 'pull-request', number: 11, state: 'open', draft: false,
    base: 'a'.repeat(40), head: 'b'.repeat(40), labels: ['automation/ci-failed'],
  }
  const stateVersion = subjectStateVersion(pullRequest)
  const firstTransition = ciRepairTransition(300)
  const secondTransition = ciRepairTransition(400)
  const firstCandidate = governorDecision({
    transition: firstTransition, subject: pullRequest, stateVersion,
    observationId: 'repair-run-1:1', records: [],
  }).record
  const firstAdmission = governorDecision({
    transition: firstTransition, subject: pullRequest, stateVersion,
    observationId: 'repair-run-2:1', records: [firstCandidate],
  })
  assert.equal(firstAdmission.action, 'admit')
  const firstApplied = {
    version: 1, status: 'applied', transition: firstTransition,
    subject: { type: 'pull-request', number: 11 }, stateVersion,
    observationId: 'repair-run-2:1',
  }
  assert.equal(governorDecision({
    transition: secondTransition, subject: pullRequest, stateVersion,
    observationId: 'repair-run-3:1', records: [firstCandidate, firstAdmission.record, firstApplied],
  }).action, 'record-candidate')

  const firstBudget = governorBudgetDecision({
    transition: 'ci-repair', subject: { type: 'pull-request', number: 11 },
    workIdentity: 'branch:agent/issue-1', observationId: 'repair-run-2:1', limit: 3, records: [],
  })
  const secondBudget = governorBudgetDecision({
    transition: 'ci-repair', subject: { type: 'pull-request', number: 11 },
    workIdentity: 'branch:agent/issue-1', observationId: 'repair-run-4:1', limit: 3,
    records: [firstBudget.record],
  })
  assert.equal(firstBudget.record.attempt, 1)
  assert.equal(secondBudget.record.attempt, 2)
})

test('replaying one recovery observation consumes its independent budget once', () => {
  const first = governorBudgetDecision({
    transition: 'workflow-recovery',
    subject: { type: 'pull-request', number: 9 },
    workIdentity: 'branch:agent/fix',
    observationId: 'recovery-run-400',
    limit: 3,
    records: [{ status: 'admitted', observationId: 'candidate-400' }],
  })
  assert.equal(first.action, 'attempt')
  assert.equal(first.record.attempt, 1)
  assert.deepEqual(governorBudgetDecision({
    transition: 'workflow-recovery',
    subject: { type: 'pull-request', number: 9 },
    workIdentity: 'branch:agent/fix',
    observationId: 'recovery-run-400',
    limit: 3,
    records: [first.record],
  }), {
    action: 'noop',
    execute: false,
    reason: 'attempt-already-recorded',
  })
})

test('stable controller rollout freezes during product critical work and batches revisions', () => {
  const deferred = rolloutDecision({
    stableRevision: 'a'.repeat(40),
    proposedRevisions: ['b'.repeat(40), 'c'.repeat(40)],
    activeProductPullRequests: [{ number: 7, phase: 'ci' }],
    faultBound: false,
    lastPromotionDay: '2026-08-16',
    promotionDay: '2026-08-17',
  })
  assert.deepEqual(deferred, {
    action: 'defer',
    stableRevision: 'a'.repeat(40),
    pendingRevision: 'c'.repeat(40),
    supersededRevisions: ['b'.repeat(40)],
    reason: 'product-critical-section',
  })
  assert.deepEqual(rolloutDecision({
    stableRevision: 'a'.repeat(40),
    proposedRevisions: ['b'.repeat(40), 'c'.repeat(40)],
    activeProductPullRequests: [],
    faultBound: false,
    lastPromotionDay: '2026-08-16',
    promotionDay: '2026-08-17',
  }), {
    action: 'promote',
    stableRevision: 'c'.repeat(40),
    supersededRevisions: ['b'.repeat(40)],
    promotionDay: '2026-08-17',
  })
  assert.deepEqual(rolloutDecision({
    stableRevision: 'a'.repeat(40),
    proposedRevisions: ['b'.repeat(40), 'c'.repeat(40)],
    activeProductPullRequests: [],
    faultBound: false,
    lastPromotionDay: '2026-08-17',
    promotionDay: '2026-08-17',
  }), {
    action: 'defer',
    stableRevision: 'a'.repeat(40),
    pendingRevision: 'c'.repeat(40),
    supersededRevisions: ['b'.repeat(40)],
    reason: 'daily-promotion-slot-consumed',
  })
  assert.deepEqual(rolloutDecision({
    stableRevision: 'a'.repeat(40),
    proposedRevisions: ['d'.repeat(40)],
    activeProductPullRequests: [{ number: 7, phase: 'landing' }],
    faultBound: true,
    lastPromotionDay: '2026-08-17',
    promotionDay: '2026-08-17',
  }), {
    action: 'promote',
    stableRevision: 'd'.repeat(40),
    supersededRevisions: [],
    promotionDay: '2026-08-17',
  })
  assert.throws(() => rolloutDecision({
    stableRevision: 'a'.repeat(40),
    proposedRevisions: ['b'.repeat(40)],
    activeProductPullRequests: [],
    faultBound: false,
    lastPromotionDay: '2026-99-99',
    promotionDay: '2026-08-17',
  }), /evidence is incomplete/)
})

test('controller promotion keeps targets on stable revision until the critical section ends', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'governor-promotion-'))
  context.after(() => rm(directory, { recursive: true, force: true }))
  const recordPath = join(directory, 'controller-release.json')
  const snapshotPath = join(directory, 'snapshot.json')
  const stable = 'a'.repeat(40)
  const pending = 'b'.repeat(40)
  const deferred = 'c'.repeat(40)
  const promoted = 'd'.repeat(40)
  const promotionDay = new Date().toISOString().slice(0, 10)
  const previousPromotionDay = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)
  await writeFile(recordPath, `${JSON.stringify({
    version: 2,
    stableRevision: stable,
    pendingRevisions: [pending],
    lastPromotionDay: previousPromotionDay,
  })}\n`)
  await writeFile(`${recordPath}.tmp`, 'interrupted legacy promotion')
  await writeFile(snapshotPath, `${JSON.stringify({ activeProductPullRequests: [{ number: 7, phase: 'review' }] })}\n`)
  const deferredOutput = execFileSync(process.execPath, [
    fileURLToPath(new URL('../src/promote-controller.mjs', import.meta.url)),
    '--record', recordPath,
    '--snapshot', snapshotPath,
    '--candidate', deferred,
  ], { encoding: 'utf8' })
  assert.match(deferredOutput, new RegExp(`superseded pending controller revisions: ${pending}`))
  assert.deepEqual(JSON.parse(await readFile(recordPath, 'utf8')), {
    version: 2,
    stableRevision: stable,
    pendingRevisions: [deferred],
    lastPromotionDay: previousPromotionDay,
  })

  await writeFile(snapshotPath, `${JSON.stringify({ activeProductPullRequests: [] })}\n`)
  execFileSync(process.execPath, [
    fileURLToPath(new URL('../src/promote-controller.mjs', import.meta.url)),
    '--record', recordPath,
    '--snapshot', snapshotPath,
    '--candidate', promoted,
  ])
  assert.deepEqual(JSON.parse(await readFile(recordPath, 'utf8')), {
    version: 2,
    stableRevision: promoted,
    pendingRevisions: [],
    lastPromotionDay: promotionDay,
  })

  const later = 'e'.repeat(40)
  const dailyOutput = execFileSync(process.execPath, [
    fileURLToPath(new URL('../src/promote-controller.mjs', import.meta.url)),
    '--record', recordPath,
    '--snapshot', snapshotPath,
    '--candidate', later,
  ], { encoding: 'utf8' })
  assert.match(dailyOutput, /defer: stable controller revision/)
  assert.deepEqual(JSON.parse(await readFile(recordPath, 'utf8')), {
    version: 2,
    stableRevision: promoted,
    pendingRevisions: [later],
    lastPromotionDay: promotionDay,
  })
  assert.throws(() => execFileSync(process.execPath, [
    fileURLToPath(new URL('../src/promote-controller.mjs', import.meta.url)),
    '--record', recordPath,
    '--snapshot', snapshotPath,
    '--candidate', 'f'.repeat(40),
    '--promotion-day', '2000-01-01',
  ], { encoding: 'utf8', stdio: 'pipe' }), /Promotion day is derived from the current UTC date/)
})

test('GitHub governor state accepts only records attested by the pinned controller workflow', async () => {
  const stateVersion = subjectStateVersion(issue)
  const record = {
    version: 1,
    status: 'applied',
    transition: 'issue-dispatch',
    subject: { type: 'issue', number: 44 },
    stateVersion,
    observationId: 'run-300',
  }
  const trust = {
    repository: 'owner/target',
    controllerRepository: 'owner/controller',
    controllerSha: 'a'.repeat(40),
    workflowPath: '.github/workflows/dispatch-backlog.yml',
  }
  const body = attestedGovernorRecordBody(record, { ...trust, runId: 300 })
  const comments = [{ user: { login: 'github-actions[bot]' }, author_association: 'NONE', body }]
  const records = await trustedGovernorRecords({
    comments,
    trust,
    loadRun: async () => ({
      id: 300,
      repository: { full_name: 'owner/target' },
      referenced_workflows: [{
        path: `owner/controller/${trust.workflowPath}@${trust.controllerSha}`,
        sha: trust.controllerSha,
      }],
    }),
  })
  assert.deepEqual(records, [record])

  await assert.rejects(trustedGovernorRecords({
    comments,
    trust,
    loadRun: async () => ({
      id: 300,
      repository: { full_name: 'owner/target' },
      referenced_workflows: [],
    }),
  }), /not attested/)
})

test('event replay reconstructs admission across a restart and controller upgrade', async () => {
  const stateVersion = subjectStateVersion(issue)
  const candidate = governorDecision({
    transition: 'issue-dispatch', subject: issue, stateVersion,
    observationId: 'scheduled-run-500', records: [],
  }).record
  const oldSha = 'a'.repeat(40)
  const newSha = 'b'.repeat(40)
  const trust = {
    repository: 'owner/target',
    controllerRepository: 'owner/controller',
    workflowPaths: ['.github/workflows/dispatch-backlog.yml'],
  }
  const comment = (record, runId, controllerSha) => ({
    user: { login: 'github-actions[bot]' },
    body: attestedGovernorRecordBody(record, {
      repository: trust.repository,
      controllerRepository: trust.controllerRepository,
      controllerSha,
      workflowPath: trust.workflowPaths[0],
      runId,
    }),
  })
  const runs = new Map([
    [500, {
      id: 500,
      repository: { full_name: trust.repository },
      referenced_workflows: [{
        path: `${trust.controllerRepository}/${trust.workflowPaths[0]}@${oldSha}`,
        sha: oldSha,
      }],
    }],
  ])
  const restoredCandidate = await trustedGovernorRecords({
    comments: [comment(candidate, 500, oldSha)],
    trust,
    loadRun: async runId => runs.get(runId),
  })
  const admission = governorDecision({
    transition: 'issue-dispatch', subject: issue, stateVersion,
    observationId: 'scheduled-run-501', records: restoredCandidate,
  })
  assert.equal(admission.action, 'admit')
  assert.equal(admission.record.candidateObservationId, 'scheduled-run-500')

  const applied = {
    version: 1,
    status: 'applied',
    transition: 'issue-dispatch',
    subject: { type: 'issue', number: issue.number },
    stateVersion,
    observationId: 'scheduled-run-501',
  }
  runs.set(501, {
    id: 501,
    repository: { full_name: trust.repository },
    referenced_workflows: [{
      path: `${trust.controllerRepository}/${trust.workflowPaths[0]}@${newSha}`,
      sha: newSha,
    }],
  })
  const restoredAfterUpgrade = await trustedGovernorRecords({
    comments: [comment(candidate, 500, oldSha), comment(applied, 501, newSha)],
    trust,
    loadRun: async runId => runs.get(runId),
  })
  assert.deepEqual(governorDecision({
    transition: 'issue-dispatch', subject: issue, stateVersion,
    observationId: 'scheduled-run-502', records: restoredAfterUpgrade,
  }), {
    action: 'noop',
    execute: false,
    reason: 'transition-already-applied',
  })
})

test('generic governor policy contains no product or Agent implementation branches', async () => {
  const source = await readFile(new URL('../src/governor-policy.mjs', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /deepseek|dsh|codex|openai|claude|opencode|gui/i)
})
