import assert from 'node:assert/strict'
import test from 'node:test'
import {
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
  const applied = new Set()
  const effects = []
  const journal = {
    isApplied: value => applied.has(value.transitionIdentity),
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
