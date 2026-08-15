import assert from 'node:assert/strict'
import test from 'node:test'
import {
  addedPatchLine,
  assertChangedLineExcerpt,
  assertLineExcerpt,
  referencedLine,
} from '../src/line-evidence.mjs'

test('referencedLine handles CRLF and rejects lines outside the file', () => {
  assert.equal(referencedLine('first\r\nsecond\r\nthird', 2, 'a.txt'), 'second')
  assert.throws(() => referencedLine('one', 0, 'a.txt'), /outside a\.txt/)
  assert.throws(() => referencedLine('one', 2, 'a.txt'), /outside a\.txt/)
})

test('assertLineExcerpt requires the excerpt on the exact referenced line', () => {
  assert.doesNotThrow(() => assertLineExcerpt({ content: 'alpha\nbeta value', line: 2, excerpt: 'beta', reference: 'a.txt' }))
  assert.throws(() => assertLineExcerpt({ content: 'alpha\nbeta value', line: 1, excerpt: 'beta', reference: 'a.txt' }), /does not match/)
})

test('addedPatchLine tracks additions across multiple hunks, context, and deletions', () => {
  const patch = [
    '@@ -1,2 +1,3 @@',
    ' first',
    '-old',
    '+second',
    '+third',
    '@@ -8,2 +9,2 @@',
    '-removed',
    '+ninth',
    ' tenth',
    '\\ No newline at end of file',
  ].join('\r\n')
  assert.equal(addedPatchLine(patch, 2), 'second')
  assert.equal(addedPatchLine(patch, 3), 'third')
  assert.equal(addedPatchLine(patch, 9), 'ninth')
  assert.equal(addedPatchLine(patch, 10), undefined)
})

test('addedPatchLine ignores file headers and deletion-only patches', () => {
  assert.equal(addedPatchLine('--- a/a.txt\n+++ b/a.txt\n@@ -1 +0,0 @@\n-only', 1), undefined)
})

test('assertChangedLineExcerpt requires both the head file and exact added diff line', () => {
  const content = 'stable\nnew behavior\n'
  const patch = '@@ -1 +1,2 @@\n stable\n+new behavior'
  assert.doesNotThrow(() => assertChangedLineExcerpt({ content, patch, line: 2, excerpt: 'behavior', reference: 'a.txt' }))
  assert.throws(() => assertChangedLineExcerpt({ content, patch, line: 1, excerpt: 'stable', reference: 'a.txt' }), /changed line/)
  assert.throws(() => assertChangedLineExcerpt({ content, patch, line: 2, excerpt: 'missing', reference: 'a.txt' }), /does not match line/)
})
