import assert from 'node:assert/strict'
import test from 'node:test'
import { subjectStateVersion } from '../src/governor-policy.mjs'
import {
  advancementRepairCandidate,
  advancementTransitionIdentity,
  consumePullRequestAdvancement,
  repairObservationIdFromGovernorRecord,
} from '../src/advancement-runtime.mjs'
import { advancementRepairObservationId } from '../src/work-request.mjs'
const sha = letter => letter.repeat(40)
const digest = letter => letter.repeat(64)
function decision(action, overrides = {}) {
  return {
    action,
    repository: 'owner/repository',
    pullRequestNumber: 12,
    pair: { base: sha('a'), head: sha('b') },
    stateVersion: digest('d'),
    workflow: { definitionHash: digest('c'), workflowId: 'default', stageId: 'review' },
    ...overrides,
  }
}
test('merge-conflict and failed-check repair decisions create one exact candidate', () => {
  for (const reason of ['merge-conflict', 'failed-check']) {
    const subject = {
      type: 'pull-request', number: 12, state: 'open', draft: false,
      base: sha('a'), head: sha('b'), labels: [],
    }
    const value = decision('request-repair', { stateVersion: subjectStateVersion(subject) })
    const identity = advancementTransitionIdentity(value)
    const result = advancementRepairCandidate({
      records: [],
      subject,
      stateVersion: value.stateVersion,
      transitionIdentity: identity,
      ...(reason === 'merge-conflict' ? { repairCause: reason } : {}),
    })
    assert.equal(result.transition, `${reason === 'merge-conflict' ? 'merge-repair' : 'review-repair'}:${advancementRepairObservationId(identity)}`, reason)
    assert.equal(result.record.status, 'candidate', reason)
  }
})
test('automatic BLOCK and manual rework produce one decision-bound repair candidate', () => {
  const subject = {
    type: 'pull-request', number: 12, state: 'open', draft: false,
    base: sha('a'), head: sha('b'), labels: [],
  }
  const value = decision('request-repair', { stateVersion: subjectStateVersion(subject) })
  for (const transition of ['review-repair:run-91', 'review-repair']) {
    const record = {
      version: 1, status: 'candidate', transition,
      subject: { type: 'pull-request', number: 12 },
      stateVersion: value.stateVersion,
      observationId: transition === 'review-repair' ? 'comment-4' : 'run-91',
    }
    const result = advancementRepairCandidate({
      records: [record],
      subject,
      stateVersion: value.stateVersion,
      transitionIdentity: advancementTransitionIdentity(value),
    })
    const identity = advancementTransitionIdentity(value)
    assert.equal(result.transition, `review-repair:${advancementRepairObservationId(identity)}`)
    assert.equal(result.record.status, 'candidate')
    const duplicate = advancementRepairCandidate({
      records: [record, result.record],
      subject,
      stateVersion: value.stateVersion,
      transitionIdentity: identity,
    })
    assert.deepEqual(duplicate, { transition: result.transition, record: null })
  }
})
test('duplicate wakes keep one stable transition identity and stale wakes perform no effect', async () => {
  const value = decision('request-landing')
  assert.equal(advancementTransitionIdentity(value), advancementTransitionIdentity(structuredClone(value)))
  const effects = []
  await consumePullRequestAdvancement(decision('stale'), {
    requestReview: entry => effects.push(entry),
    requestRepair: entry => effects.push(entry),
    requestLanding: entry => effects.push(entry),
  })
  assert.deepEqual(effects, [])
})
test('repair transition identity includes the verified candidate generation', () => {
  const base = decision('request-repair', {
    repair: { cause: 'review-block', candidate: null },
  })
  const candidate = {
    ...base,
    repair: {
      cause: 'review-block',
      candidate: { transition: 'review-repair:run-91', observationId: 'run-91' },
    },
  }
  assert.notEqual(advancementTransitionIdentity(base), advancementTransitionIdentity(candidate))
  assert.notEqual(
    advancementTransitionIdentity(candidate),
    advancementTransitionIdentity({
      ...candidate,
      repair: { ...candidate.repair, candidate: { transition: 'review-repair:run-92', observationId: 'run-92' } },
    }),
  )
})
test('admitted repair replay restores the original candidate observation', () => {
  const candidate = { status: 'candidate', observationId: 'comment-9001' }
  const admission = { status: 'admitted', observationId: '9001:1', candidateObservationId: candidate.observationId }
  assert.equal(repairObservationIdFromGovernorRecord('review-repair', admission), 'comment-9001')
  assert.equal(repairObservationIdFromGovernorRecord('review-repair:run-42', admission), 'run-42')
})
test('a durable applied transition makes duplicate landing wakes one effective request', async () => {
  const claimed = new Set()
  const applied = new Set()
  const effects = []
  const journal = {
    claim: value => {
      if (applied.has(value.transitionIdentity) || claimed.has(value.transitionIdentity)) return false
      claimed.add(value.transitionIdentity)
      return true
    },
    markApplied: value => applied.add(value.transitionIdentity),
  }
  const route = {
    requestReview: value => effects.push(['review', value.transitionIdentity]),
    requestRepair: value => effects.push(['repair', value.transitionIdentity]),
    requestLanding: value => effects.push(['landing', value.transitionIdentity]),
  }
  await consumePullRequestAdvancement(decision('request-landing'), route, journal)
  const duplicate = await consumePullRequestAdvancement(decision('request-landing'), route, journal)
  assert.deepEqual(effects, [['landing', advancementTransitionIdentity(decision('request-landing'))]])
  assert.equal(duplicate.alreadyApplied, true)
})
test('parallel duplicate wakes share one claim and one effective mutation', async () => {
  const claimed = new Set()
  let effects = 0
  const journal = {
    claim: value => {
      if (claimed.has(value.transitionIdentity)) return false
      claimed.add(value.transitionIdentity)
      return true
    },
    markApplied: () => undefined,
  }
  const route = {
    requestReview: () => { effects += 1 },
    requestRepair: () => { effects += 1 },
    requestLanding: async () => { await Promise.resolve(); effects += 1 },
  }
  await Promise.all([
    consumePullRequestAdvancement(decision('request-landing'), route, journal),
    consumePullRequestAdvancement(decision('request-landing'), route, journal),
  ])
  assert.equal(effects, 1)
})
test('a transient applied-record failure retries the journal without replaying the effect', async () => {
  let effects = 0
  let marks = 0
  await consumePullRequestAdvancement(decision('request-landing'), {
    requestReview: () => undefined,
    requestRepair: () => undefined,
    requestLanding: () => { effects += 1 },
  }, {
    claim: () => true,
    markApplied: () => {
      marks += 1
      if (marks === 1) throw new Error('transient comment failure')
    },
  })
  assert.equal(effects, 1)
  assert.equal(marks, 2)
})
test('persistent applied-record failure leaves dispatched work recoverable', async () => {
  let effects = 0
  const journal = { claim: () => true, markInflight: () => undefined, markApplied: () => { throw new Error('persistent comment failure') } }
  const route = { requestReview: () => { effects += 1 }, requestRepair: () => { effects += 1 }, requestLanding: () => { effects += 1 } }
  for (const action of ['request-review', 'request-repair']) {
    const before = effects
    await assert.rejects(consumePullRequestAdvancement(decision(action), route, journal), /persistent comment failure/)
    await assert.rejects(consumePullRequestAdvancement(decision(action), route, journal), /persistent comment failure/)
    assert.equal(effects, before + 2, action)
  }
})
test('a dispatch failure after inflight journaling is retried on the next wake', async () => {
  const inflight = new Set()
  const applied = new Set()
  let effects = 0
  const journal = {
    claim: value => !applied.has(value.transitionIdentity),
    markInflight: value => inflight.add(value.transitionIdentity),
    markApplied: value => applied.add(value.transitionIdentity),
  }
  const route = {
    requestReview: async value => {
      effects += 1
      if (effects === 1) throw new Error('repository dispatch failed')
      assert.equal(inflight.has(value.transitionIdentity), true)
    },
    requestRepair: () => undefined,
    requestLanding: () => undefined,
  }
  await assert.rejects(consumePullRequestAdvancement(decision('request-review'), route, journal), /repository dispatch failed/)
  await consumePullRequestAdvancement(decision('request-review'), route, journal)
  assert.equal(effects, 2)
  assert.equal(applied.size, 1)
})
