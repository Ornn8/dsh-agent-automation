import { createHash } from 'node:crypto'
import { parseJson } from './common.mjs'

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const IDENTITY = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,127}$/
const MAX_IDENTIFIERS = 32
const MAX_IDENTIFIER_LENGTH = 128
const MAX_SOURCE_BYTES = 16 * 1024
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const FULL_SHA = /^[0-9a-f]{40}$/
const SHA256 = /^[0-9a-f]{64}$/

function requireObject(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${name} must be an object`)
  }
  return value
}

function requireFields(value, required, allowed, name) {
  const object = requireObject(value, name)
  for (const key of Object.keys(object)) {
    if (!allowed.has(key)) throw new Error(`${name} has unknown field ${key}`)
  }
  for (const key of required) {
    if (!Object.hasOwn(object, key)) throw new Error(`${name} is missing required field ${key}`)
  }
  return object
}

function identifier(value, name, pattern = ID, maximum = 64) {
  const canonical = typeof value === 'string' ? value.trim() : ''
  if (!canonical || !pattern.test(canonical) || canonical.length > maximum) {
    throw new Error(`${name} must be a canonical identifier of at most ${maximum} characters`)
  }
  return canonical
}

function uniqueIdentifiers(value, name) {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_IDENTIFIERS) {
    throw new Error(`${name} must contain from 1 to ${MAX_IDENTIFIERS} identifiers`)
  }
  const result = value.map((item, index) => {
    if (typeof item !== 'string' || !item.trim() || item.trim().length > MAX_IDENTIFIER_LENGTH
      || /[\r\n\u0000-\u001f]/.test(item)) {
      throw new Error(`${name}[${index}] must be one-line text of at most ${MAX_IDENTIFIER_LENGTH} characters`)
    }
    return item.trim()
  })
  if (new Set(result).size !== result.length) throw new Error(`${name} must not contain duplicates`)
  return result.sort()
}

/** Parse one execution identity with the same bounds as a contract entrypoint. */
export function parseVerificationExecutionIdentity(value, name = 'Verification execution identity') {
  return identifier(value, name, IDENTITY, MAX_IDENTIFIER_LENGTH)
}

/** Parse one bounded, unique evidence identifier list for a verification receipt. */
export function parseVerificationEvidenceIdentifiers(value, name = 'Verification receipt evidence') {
  return uniqueIdentifiers(value, name)
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  for (const child of Object.values(value)) deepFreeze(child)
  return Object.freeze(value)
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

/** Validate and normalize one target-owned verification contract. */
export function parseVerificationContract(value) {
  const object = requireFields(
    value,
    ['version', 'contractId', 'requiredChecks', 'requiredEvidence'],
    new Set(['version', 'contractId', 'procedure', 'entrypoint', 'requiredChecks', 'requiredEvidence']),
    'Verification Contract',
  )
  if (object.version !== 1) throw new Error('Verification Contract version must be 1')
  const hasProcedure = Object.hasOwn(object, 'procedure')
  const hasEntrypoint = Object.hasOwn(object, 'entrypoint')
  if (hasProcedure === hasEntrypoint) {
    throw new Error('Verification Contract must declare exactly one of procedure or entrypoint')
  }
  const identityField = hasProcedure ? 'procedure' : 'entrypoint'
  const normalized = {
    version: 1,
    contractId: identifier(object.contractId, 'Verification Contract contractId'),
    [identityField]: identifier(object[identityField], `Verification Contract ${identityField}`, IDENTITY, 128),
    requiredChecks: uniqueIdentifiers(object.requiredChecks, 'Verification Contract requiredChecks'),
    requiredEvidence: uniqueIdentifiers(object.requiredEvidence, 'Verification Contract requiredEvidence'),
  }
  return deepFreeze(normalized)
}

/** Return the stable SHA-256 identity of one normalized verification contract. */
export function verificationContractHash(value) {
  return createHash('sha256').update(canonicalJson(parseVerificationContract(value))).digest('hex')
}

/** Parse one bounded immutable identity that names a verification contract. */
export function parseVerificationContractIdentity(value) {
  const object = requireFields(
    value,
    ['contractId', 'hash'],
    new Set(['contractId', 'hash']),
    'WorkRequest verificationContract',
  )
  const contractId = identifier(object.contractId, 'WorkRequest verificationContract contractId')
  if (!SHA256.test(object.hash || '')) {
    throw new Error('WorkRequest verificationContract hash must be a SHA-256 digest')
  }
  return deepFreeze({ contractId, hash: object.hash })
}

/** Derive the immutable WorkRequest identity from one trusted loaded contract. */
export function verificationContractIdentity(value) {
  const contract = parseVerificationContract(value?.contract)
  const hash = verificationContractHash(contract)
  if (value?.hash !== hash) throw new Error('Trusted Verification Contract hash does not match the contract contents')
  return parseVerificationContractIdentity({ contractId: contract.contractId, hash })
}

/** Parse one bounded verification-contract JSON source. */
export function parseVerificationContractSource(source, description = 'Verification Contract') {
  if (typeof source !== 'string' || !source) throw new Error(`${description} content reader returned no content`)
  if (Buffer.byteLength(source, 'utf8') > MAX_SOURCE_BYTES) {
    throw new Error(`${description} exceeds the ${MAX_SOURCE_BYTES} byte limit`)
  }
  return parseVerificationContract(parseJson(source, description))
}

function trustedPath(value) {
  if (typeof value !== 'string' || !value || value.length > 256 || value.includes('\\')
    || value.startsWith('/') || value.includes('//') || value.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error('Trusted Verification Contract path is invalid')
  }
  return value
}

/** Load and validate a verification contract from one exact trusted repository revision. */
export async function loadTrustedVerificationContract({ repository, revision, path, loadContent }) {
  if (!REPOSITORY.test(repository || '')) throw new Error('Trusted Verification Contract repository is invalid')
  if (!FULL_SHA.test(revision || '')) throw new Error('Trusted Verification Contract revision must be a full lowercase SHA')
  if (typeof loadContent !== 'function') throw new Error('Trusted Verification Contract loading requires a content reader')
  const contractPath = trustedPath(path)
  const source = await loadContent({ repository, revision, path: contractPath })
  const contract = parseVerificationContractSource(
    source,
    `Verification Contract at ${repository}@${revision}:${contractPath}`,
  )
  return deepFreeze({
    contract,
    hash: verificationContractHash(contract),
    repository,
    revision,
    path: contractPath,
  })
}
