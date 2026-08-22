import assert from 'node:assert/strict'
import test from 'node:test'
import {
  assertVerificationContractChecks,
  assertVerificationContractExecution,
  loadTrustedVerificationContract,
  parseVerificationContract,
  verificationJobId,
  verificationContractHash,
} from '../src/verification-contract.mjs'

function validContract() {
  return {
    version: 1,
    contractId: 'delivery-v1',
    entrypoint: 'verify/delivery',
    requiredChecks: ['build', 'unit-tests'],
    requiredEvidence: ['changed-paths', 'test-report'],
  }
}

test('parses and freezes one bounded verification contract', () => {
  const contract = parseVerificationContract({
    ...validContract(),
    requiredChecks: [' unit-tests ', 'build'],
    requiredEvidence: ['test-report', 'changed-paths'],
  })
  assert.deepEqual(contract, validContract())
  assert.ok(Object.isFrozen(contract))
  assert.ok(Object.isFrozen(contract.requiredChecks))
  assert.throws(() => { contract.requiredChecks.push('extra') }, TypeError)
})

test('rejects missing, unknown, unsupported, and oversized contract fields', () => {
  const missing = validContract()
  delete missing.requiredEvidence
  assert.throws(() => parseVerificationContract(missing), /missing required field requiredEvidence/)

  assert.throws(() => parseVerificationContract({ ...validContract(), extra: true }), /unknown field extra/)
  assert.throws(() => parseVerificationContract({ ...validContract(), version: 2 }), /version must be 1/)
  assert.throws(() => parseVerificationContract({
    ...validContract(), entrypoint: 'bad identity with spaces',
  }), /entrypoint/)
  assert.throws(() => parseVerificationContract({
    ...validContract(), requiredChecks: Array.from({ length: 33 }, (_, index) => `check-${index}`),
  }), /requiredChecks/)
  assert.throws(() => parseVerificationContract({
    ...validContract(), contractId: 'x'.repeat(65),
  }), /contractId/)
})

test('canonical hash ignores permitted formatting but changes on semantic edits', () => {
  const first = validContract()
  const second = {
    requiredEvidence: ['test-report', 'changed-paths'],
    requiredChecks: ['unit-tests', 'build'],
    entrypoint: ' verify/delivery ',
    contractId: 'delivery-v1',
    version: 1,
  }
  assert.equal(verificationContractHash(first), verificationContractHash(second))
  assert.notEqual(verificationContractHash(first), verificationContractHash({
    ...first,
    requiredEvidence: ['changed-paths', 'security-report'],
  }))
})

test('requires configured CI checks to equal the trusted contract checks', () => {
  const contract = {
    contract: parseVerificationContract(validContract()),
    hash: verificationContractHash(validContract()),
  }
  assert.doesNotThrow(() => assertVerificationContractChecks({
    trustedVerificationContract: contract,
    configuredRequiredChecks: [{ context: 'unit-tests', app_id: 15368 }, 'build'],
  }))
  assert.throws(() => assertVerificationContractChecks({
    trustedVerificationContract: contract,
    configuredRequiredChecks: ['build'],
  }), /do not match trusted Verification Contract/)
  assert.throws(() => assertVerificationContractChecks({
    trustedVerificationContract: contract,
    configuredRequiredChecks: ['build', 'unit-tests', 'security'],
  }), /do not match trusted Verification Contract/)
  assert.throws(() => assertVerificationContractChecks({
    trustedVerificationContract: { ...contract, hash: '0'.repeat(64) },
    configuredRequiredChecks: ['build', 'unit-tests'],
  }), /hash does not match/)
  assert.doesNotThrow(() => assertVerificationContractChecks({
    trustedVerificationContract: undefined,
    configuredRequiredChecks: ['unconfigured-check'],
  }))
})

test('rejects an extra independent branch-protection check before app binding', () => {
  const contract = {
    contract: parseVerificationContract(validContract()),
    hash: verificationContractHash(validContract()),
  }
  assert.throws(() => assertVerificationContractChecks({
    trustedVerificationContract: contract,
    configuredRequiredChecks: [
      { context: 'build', app_id: 15368 },
      { context: 'unit-tests', app_id: 15368 },
      { context: 'security', app_id: 15368 },
    ],
  }), /do not match trusted Verification Contract/)
})

test('requires a successful required-check job step for the trusted entrypoint', () => {
  const contract = {
    contract: parseVerificationContract(validContract()),
    hash: verificationContractHash(validContract()),
  }
  const checkRun = {
    name: 'unit-tests',
    head_sha: 'a'.repeat(40),
    status: 'completed',
    conclusion: 'success',
  }
  const job = {
    name: 'unit-tests',
    head_sha: checkRun.head_sha,
    status: 'completed',
    conclusion: 'success',
    steps: [{ name: 'verify/delivery', status: 'completed', conclusion: 'success' }],
  }
  assert.doesNotThrow(() => assertVerificationContractExecution({
    trustedVerificationContract: contract,
    executions: [{ checkRun, job }],
  }))
  assert.throws(() => assertVerificationContractExecution({
    trustedVerificationContract: contract,
    executions: [{ checkRun, job: { ...job, steps: [] } }],
  }), /do not prove trusted Verification Contract execution/)
  assert.doesNotThrow(() => assertVerificationContractExecution({
    trustedVerificationContract: undefined,
    executions: [],
  }))
})

test('accepts only a job details URL for the configured repository', () => {
  assert.equal(
    verificationJobId('https://github.com/owner/repository/actions/runs/17/job/23', 'owner/repository'),
    23,
  )
  assert.equal(
    verificationJobId('https://github.com/owner/other/actions/runs/17/job/23', 'owner/repository'),
    null,
  )
  assert.equal(verificationJobId('https://github.com/owner/repository/actions/runs/17', 'owner/repository'), null)
})

test('loads one immutable contract only from the supplied trusted revision', async () => {
  const calls = []
  const revision = 'a'.repeat(40)
  const loaded = await loadTrustedVerificationContract({
    repository: 'owner/repository',
    revision,
    path: '.github/agent-automation/profiles/delivery/verification.json',
    loadContent: async request => {
      calls.push(request)
      return JSON.stringify(validContract())
    },
  })
  assert.deepEqual(calls, [{
    repository: 'owner/repository',
    revision,
    path: '.github/agent-automation/profiles/delivery/verification.json',
  }])
  assert.equal(loaded.hash, verificationContractHash(validContract()))
  assert.ok(Object.isFrozen(loaded))
  assert.ok(Object.isFrozen(loaded.contract))
  await assert.rejects(loadTrustedVerificationContract({
    repository: 'owner/repository',
    revision,
    path: '.github/agent-automation/profiles/delivery/verification.json',
    loadContent: async () => undefined,
  }), /content reader returned no content/)
  await assert.rejects(loadTrustedVerificationContract({
    repository: 'owner/repository',
    revision,
    path: '.github/agent-automation/profiles/delivery/verification.json',
    loadContent: async () => '{',
  }), /not valid JSON/)
  await assert.rejects(loadTrustedVerificationContract({
    repository: 'owner/repository',
    revision,
    path: '.github/agent-automation/profiles/delivery/verification.json',
    loadContent: async () => ' '.repeat(16 * 1024 + 1),
  }), /byte limit/)
})
