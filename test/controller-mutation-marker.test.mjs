import assert from 'node:assert/strict'
import test from 'node:test'
import {
  controllerMutationMarker,
  parseControllerMutationMarker,
  trustedControllerMutation,
} from '../src/controller-mutation-marker.mjs'
import { trustedWorkerIdentity } from '../src/workflow-identity.mjs'

const sha = 'a'.repeat(40)
const record = {
  version: 1,
  operation: 'change-worker',
  repository: 'owner/target',
  subject: { type: 'issue', number: 7 },
  runUrl: 'https://github.com/owner/target/actions/runs/123',
  controller: {
    repository: 'owner/controller',
    workflowPath: '.github/workflows/dsh-issue.yml',
    sha,
  },
}

test('Controller mutation markers are strict terminal audit records', () => {
  const body = `### Agent worker run\n\n${controllerMutationMarker(record)}`
  assert.deepEqual(parseControllerMutationMarker(body), record)
  assert.throws(() => parseControllerMutationMarker(`${body}\ntrailing`), /terminal marker/)
  assert.throws(() => parseControllerMutationMarker(`${body}\n${controllerMutationMarker(record)}`), /unique terminal marker/)
  assert.throws(() => controllerMutationMarker({ ...record, extra: true }), /unexpected fields/)
  assert.throws(() => controllerMutationMarker({ ...record, runUrl: 'https://github.com/other/target/actions/runs/123' }), /invalid/)
  assert.throws(() => controllerMutationMarker({
    ...record,
    subject: { type: 'pull-request', number: 7 },
  }), /invalid/)
  assert.throws(() => controllerMutationMarker({
    ...record,
    controller: { ...record.controller, workflowPath: '.github/workflows/dsh-repair.yml' },
  }), /invalid/)
})

test('Controller mutation markers require the configured author and exact reusable workflow run', async () => {
  const body = `status\n${controllerMutationMarker(record)}`
  const comment = { user: { login: 'Ornn8' }, body }
  const run = {
    id: 123,
    repository: { full_name: 'owner/target' },
    referenced_workflows: [{
      path: `owner/controller/${record.controller.workflowPath}@${sha}`,
      sha,
    }],
  }
  assert.deepEqual(await trustedControllerMutation({
    comment,
    markerAuthor: 'Ornn8',
    expectedRepository: 'owner/target',
    expectedSubject: { type: 'issue', number: 7 },
    loadRun: async () => run,
  }), record)
  await assert.rejects(trustedControllerMutation({
    comment: { ...comment, user: { login: 'someone-else' } },
    markerAuthor: 'Ornn8',
    expectedRepository: 'owner/target',
    expectedSubject: { type: 'issue', number: 7 },
    loadRun: async () => run,
  }), /author/)
  await assert.rejects(trustedControllerMutation({
    comment,
    markerAuthor: 'Ornn8',
    expectedRepository: 'owner/target',
    expectedSubject: { type: 'issue', number: 7 },
    loadRun: async () => ({ ...run, referenced_workflows: [] }),
  }), /not backed/)
  await assert.rejects(trustedControllerMutation({
    comment,
    markerAuthor: 'Ornn8',
    expectedRepository: 'owner/other-target',
    expectedSubject: { type: 'issue', number: 7 },
    loadRun: async () => run,
  }), /expected target/)
  await assert.rejects(trustedControllerMutation({
    comment,
    markerAuthor: 'Ornn8',
    expectedRepository: 'owner/target',
    expectedSubject: { type: 'issue', number: 8 },
    loadRun: async () => run,
  }), /expected target/)
})

test('Worker identity trusts the immutable configured controller author, not the Actions actor', async () => {
  const v2Record = {
    ...record,
    version: 2,
    author: 'controller-login',
  }
  const identity = {
    profileId: 'custom-profile',
    workflowId: 'custom-cycle',
    definitionHash: 'b'.repeat(64),
    branch: 'agent/issue-7',
  }
  const body = [
    `- Profile: \`${identity.profileId}\``,
    `- Workflow: \`${identity.workflowId}\``,
    `- Definition hash: \`${identity.definitionHash}\``,
    `- Branch: \`${identity.branch}\``,
    controllerMutationMarker(v2Record),
  ].join('\n')
  const run = {
    id: 123,
    actor: { login: 'github-actions[bot]' },
    triggering_actor: { login: 'github-actions[bot]' },
    repository: { full_name: 'owner/target' },
    referenced_workflows: [{
      path: `owner/controller/${record.controller.workflowPath}@${sha}`,
      sha,
    }],
  }
  assert.deepEqual(await trustedWorkerIdentity(
    { user: { login: 'controller-login' }, body },
    { type: 'issue', number: 7 }, 'change-worker', 'owner/target', async () => run,
  ), identity)
  assert.equal(await trustedWorkerIdentity(
    { user: { login: 'someone-else' }, body },
    { type: 'issue', number: 7 }, 'change-worker', 'owner/target', async () => run,
  ), null)
  assert.equal(await trustedWorkerIdentity(
    { user: { login: 'unknown-login' }, body },
    { type: 'issue', number: 7 }, 'change-worker', 'owner/target', async () => run,
  ), null)
})
