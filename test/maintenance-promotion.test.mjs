import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { assessMaintenancePromotion, confirmMaintenancePromotionHead } from '../src/maintenance-promotion.mjs'

const head = 'a'.repeat(40)

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
