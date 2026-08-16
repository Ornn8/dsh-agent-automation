import assert from 'node:assert/strict'
import test from 'node:test'

import { reviewFindingRoute } from '../src/review-protocol.mjs'

test('review finding classes route only current pull request defects to change work', () => {
  assert.equal(reviewFindingRoute([{ class: 'product-pr' }]), 'repair')
  assert.equal(reviewFindingRoute([{ class: 'transient-environment' }]), 'retry')
  assert.equal(reviewFindingRoute([{ class: 'default-branch-baseline' }]), 'baseline')
  assert.equal(reviewFindingRoute([{ class: 'controller-infrastructure' }]), 'infrastructure')
  assert.equal(reviewFindingRoute([{ class: 'uncertain' }]), 'pause')
  assert.equal(reviewFindingRoute([{ class: 'product-pr' }, { class: 'uncertain' }]), 'pause')
})
