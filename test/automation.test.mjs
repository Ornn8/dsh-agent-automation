import assert from 'node:assert/strict'
import { mkdtemp, mkdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { issueBranch, removeJobDirectory, trustedAssociation } from '../src/common.mjs'
import { githubReviewBody, parseReviewMessage } from '../src/review-protocol.mjs'

test('issueBranch accepts the documented branch field', () => {
  assert.equal(issueBranch('## Completion\nBranch: `gui/02-shell`\n'), 'gui/02-shell')
  assert.equal(issueBranch('- Branch name: `agent/fix_1`'), 'agent/fix_1')
})

test('issueBranch rejects missing or unsafe branches', () => {
  assert.throws(() => issueBranch('No branch here'), /must declare/)
  assert.throws(() => issueBranch('Branch: `../master`'), /unsafe/)
  assert.throws(() => issueBranch('Branch: `topic@{1}`'), /unsafe/)
})

test('trustedAssociation limits privileged dispatch', () => {
  assert.equal(trustedAssociation('OWNER'), true)
  assert.equal(trustedAssociation('MEMBER'), true)
  assert.equal(trustedAssociation('COLLABORATOR'), true)
  assert.equal(trustedAssociation('CONTRIBUTOR'), false)
  assert.equal(trustedAssociation('NONE'), false)
})

test('removeJobDirectory cannot escape its declared root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-automation-root-'))
  const child = join(root, 'child')
  await mkdir(child)
  await removeJobDirectory(root, child)
  await assert.rejects(stat(child))
  await assert.rejects(removeJobDirectory(root, root), /Refusing/)
  await assert.rejects(removeJobDirectory(root, join(root, '..')), /Refusing/)
})

test('parseReviewMessage reads a hidden passing result after Chinese prose', () => {
  const review = parseReviewMessage('结论：通过。\n\n<!-- dsh-review-result\n{"verdict":"pass","summary":"No blocking defects.","findings":[]}\n-->')
  assert.deepEqual(review, { verdict: 'pass', summary: 'No blocking defects.', findings: [] })
})

test('parseReviewMessage fails closed on inconsistent results', () => {
  assert.throws(() => parseReviewMessage('plain text'), /does not end/)
  assert.throws(() => parseReviewMessage('x\n<!-- dsh-review-result\n{"verdict":"block","summary":"Blocked.","findings":[]}\n-->'), /must contain/)
})

test('githubReviewBody stays English and binds the reviewed commits', () => {
  const body = githubReviewBody({ verdict: 'pass', summary: 'No blockers.', findings: [] }, {
    marker: '<!-- marker -->',
    base: 'base123',
    head: 'head456',
  })
  assert.match(body, /Codex review: PASS/)
  assert.match(body, /head456.*base123/)
})

