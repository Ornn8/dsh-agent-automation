import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import {
  assessMaintenancePromotion,
  assertMaintenanceHeadContinuity,
  confirmMaintenancePromotionHead,
} from '../src/maintenance-promotion.mjs'
import { createFaultRecord, parseFaultRecord, recordFaultAttempt } from '../src/fault-record.mjs'

const head = 'a'.repeat(40)
const otherHead = 'b'.repeat(40)
const thirdHead = 'c'.repeat(40)

function fault() {
  return createFaultRecord({
    repository: 'owner/product', component: 'dsh-web-host', operation: 'session-list',
    failureClass: 'host', errorCode: 'connection-refused', rootRequestIds: ['issue-1'],
    stateVersion: {
      controllerSha: '1'.repeat(40), runtimeSnapshotHash: '2'.repeat(64),
      configurationHash: '3'.repeat(64), credentialGeneration: 'credential-1',
      healthGeneration: 0, failureSignature: 'connection-refused',
    },
    now: '2026-08-16T00:00:00Z',
  })
}

function reviewedAndCiRecord(reviewedHead = head, ciHead = reviewedHead) {
  let record = recordFaultAttempt(fault(), {
    kind: 'maintenance-worker', target: 'maintenance-worker', sequence: 1,
    outcome: 'succeeded', repairPullRequest: 1, at: '2026-08-16T00:01:00Z',
  })
  record = recordFaultAttempt(record, {
    kind: 'review', target: 'reviewer', sequence: 1, outcome: 'succeeded',
    head: reviewedHead, at: '2026-08-16T00:02:00Z',
  })
  return recordFaultAttempt(record, {
    kind: 'ci', target: 'controller-ci', sequence: 1, outcome: 'succeeded',
    head: ciHead, at: '2026-08-16T00:03:00Z',
  })
}

function files(count, additions = 1) {
  return Array.from({ length: count }, (_, index) => ({
    filename: `src/file-${index}.mjs`, additions, deletions: 0,
  }))
}

test('maintenance promotion rejects an above-target PR without a visible rationale', () => {
  assert.throws(() => assessMaintenancePromotion({
    pull: { head: { sha: head }, body: '' }, files: files(11),
  }), /not eligible for promotion.*split rationale/i)
})

test('maintenance promotion accepts the exact current PR body rationale for an above-target PR', () => {
  const decision = assessMaintenancePromotion({
    pull: {
      head: { sha: head },
      body: '## Split rationale\nThe repair is one atomic change and cannot be split.',
    },
    files: files(11, 45),
  })
  assert.equal(decision.expectedHead, head)
  assert.match(decision.message, /split rationale/i)
})

test('maintenance promotion rejects head or body drift after the size decision', () => {
  const decision = assessMaintenancePromotion({
    pull: { head: { sha: head }, body: 'Body' }, files: files(1),
  })
  assert.throws(() => confirmMaintenancePromotionHead({
    decision, current: { state: 'open', head: { sha: 'b'.repeat(40) }, body: 'Body' },
  }), /changed after its promotion decision/)
  assert.throws(() => confirmMaintenancePromotionHead({
    decision, current: { state: 'open', head: { sha: head }, body: 'Edited' },
  }), /changed after its promotion decision/)
  assert.doesNotThrow(() => confirmMaintenancePromotionHead({
    decision, current: { state: 'open', head: { sha: head }, body: 'Body' },
  }))
})

test('maintenance CI rejects a persisted review head drift before trusting the current PR', () => {
  const record = reviewedAndCiRecord(head, head)
  assert.throws(() => assertMaintenanceHeadContinuity(record, otherHead, ['review']), /review.*head/i)
})

test('maintenance promotion rejects CI head drift and unbound old state', () => {
  const drifted = reviewedAndCiRecord(head, otherHead)
  assert.throws(() => assertMaintenanceHeadContinuity(drifted, thirdHead, ['review', 'ci']), /ci.*head/i)

  const old = parseFaultRecord({
    ...reviewedAndCiRecord(head, head),
    attempts: reviewedAndCiRecord(head, head).attempts.map(attempt => (
      attempt.kind === 'review' ? { ...attempt, head: undefined } : attempt
    )),
  })
  assert.throws(() => assertMaintenanceHeadContinuity(old, head, ['review']), /review.*head/i)
})

test('successful maintenance promotion proves one exact head across every persisted stage', () => {
  let record = reviewedAndCiRecord(head, head)
  record = recordFaultAttempt(record, {
    kind: 'promotion', target: 'fault-bound', sequence: 1, outcome: 'succeeded',
    head, publishedSha: 'd'.repeat(40), at: '2026-08-16T00:04:00Z',
  })
  assert.equal(assertMaintenanceHeadContinuity(record, head, ['review', 'ci', 'promotion']), head)
  assert.deepEqual(
    record.attempts.filter(attempt => ['review', 'ci', 'promotion'].includes(attempt.kind)).map(attempt => attempt.head),
    [head, head, head],
  )
})

test('maintenance runtime confirms the decision before invoking gh pr merge', async () => {
  const source = await readFile(new URL('../src/maintenance-recovery.mjs', import.meta.url), 'utf8')
  const decision = source.indexOf('assessMaintenancePromotion({ pull, files })')
  const confirmation = source.indexOf('confirmMaintenancePromotionHead({ decision, current })')
  const merge = source.indexOf("['pr', 'merge'")
  assert.ok(decision >= 0)
  assert.ok(decision < confirmation)
  assert.ok(confirmation < merge)
  assert.match(source, /--match-head-commit', decision\.expectedHead/)
})

test('maintenance runtime persists and checks the exact head at every promotion stage', async () => {
  const source = await readFile(new URL('../src/maintenance-recovery.mjs', import.meta.url), 'utf8')
  assert.match(source, /assertMaintenanceHeadContinuity\(record, pull\.head\?\.sha, \['review'\]\)/)
  assert.match(source, /assertMaintenanceHeadContinuity\(record, pull\.head\?\.sha, \['review', 'ci'\]\)/)
  assert.match(source, /head: ci\.pull\.head\.sha/)
  assert.match(source, /merged\.head\?\.sha !== decision\.expectedHead/)
})
