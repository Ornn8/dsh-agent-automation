import assert from 'node:assert/strict'
import test from 'node:test'
import { subjectStateVersion } from '../src/governor-policy.mjs'
import {
  advancementRepairCandidate,
  advancementTransitionIdentity,
  consumePullRequestAdvancement,
} from '../src/advancement-runtime.mjs'

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
    })
    assert.equal(result.transition, `review-repair:advance-${identity}`, reason)
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
    assert.equal(result.transition, `review-repair:advance-${identity}`)
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

test('CI-first and review-first wakes consume the same exact-pair landing transition', async () => {
  for (const order of ['ci-first', 'review-first']) {
    const effects = []
    await consumePullRequestAdvancement(decision('request-landing'), {
      requestReview: value => effects.push(['review', value.transitionIdentity]),
      requestRepair: value => effects.push(['repair', value.transitionIdentity]),
      requestLanding: value => effects.push(['landing', value.transitionIdentity]),
    })
    assert.deepEqual(effects, [['landing', advancementTransitionIdentity(decision('request-landing'))]], order)
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

test('closed action routing never infers authority from prose', async () => {
  const observed = []
  const effects = {
    requestReview: value => observed.push(['review', value.action]),
    requestRepair: value => observed.push(['repair', value.action]),
    requestLanding: value => observed.push(['landing', value.action]),
  }
  await consumePullRequestAdvancement(decision('request-review'), effects)
  await consumePullRequestAdvancement(decision('request-repair'), effects)
  assert.deepEqual(observed, [['review', 'request-review'], ['repair', 'request-repair']])
  await assert.rejects(
    consumePullRequestAdvancement(decision('please-land-this'), effects),
    /unsupported advancement action/,
  )
})
