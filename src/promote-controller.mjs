import { randomUUID } from 'node:crypto'
import { readFile, rename, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { rolloutDecision } from './governor-policy.mjs'
import { parseFaultRecord } from './fault-record.mjs'

function argument(name) {
  const index = process.argv.indexOf(name)
  if (index < 0 || !process.argv[index + 1]) throw new Error(`Missing ${name}`)
  return process.argv[index + 1]
}

function exactKeys(value, expected, description) {
  const keys = value && typeof value === 'object' && !Array.isArray(value)
    ? Object.keys(value).sort() : []
  const wanted = [...expected].sort()
  if (keys.length !== wanted.length || keys.some((key, index) => key !== wanted[index])) {
    throw new Error(`${description} has unexpected fields`)
  }
}

function releaseRecord(value) {
  exactKeys(value, ['version', 'stableRevision', 'pendingRevisions'], 'Controller release record')
  if (!value || value.version !== 1
    || !/^[0-9a-f]{40}$/.test(value.stableRevision || '')
    || !Array.isArray(value.pendingRevisions)
    || value.pendingRevisions.some(revision => !/^[0-9a-f]{40}$/.test(revision))
    || new Set(value.pendingRevisions).size !== value.pendingRevisions.length
    || value.pendingRevisions.includes(value.stableRevision)) {
    throw new Error('Controller release record is invalid')
  }
  return value
}

function rolloutSnapshot(value) {
  exactKeys(value, ['activeProductPullRequests'], 'Controller rollout snapshot')
  if (!value || !Array.isArray(value.activeProductPullRequests)
    || value.activeProductPullRequests.some(pullRequest => !Number.isSafeInteger(pullRequest?.number)
      || pullRequest.number < 1 || !['review', 'ci', 'landing'].includes(pullRequest.phase)
      || Object.keys(pullRequest).sort().join(',') !== 'number,phase')) {
    throw new Error('Controller rollout snapshot is invalid')
  }
  return value
}

const recordPath = resolve(argument('--record'))
const snapshotPath = resolve(argument('--snapshot'))
const candidate = argument('--candidate')
const faultRecordIndex = process.argv.indexOf('--fault-record')
let faultBound = false
if (faultRecordIndex >= 0) {
  const faultRecordPath = process.argv[faultRecordIndex + 1]
  if (!faultRecordPath) throw new Error('Missing --fault-record value')
  const fault = parseFaultRecord(JSON.parse(await readFile(resolve(faultRecordPath), 'utf8')))
  const epoch = fault.epochs.at(-1).number
  const attempts = fault.attempts.filter(attempt => attempt.epoch === epoch)
  faultBound = fault.status === 'deploying'
    && Number.isSafeInteger(fault.repairPullRequest)
    && attempts.some(attempt => attempt.kind === 'review' && attempt.outcome === 'succeeded')
    && attempts.some(attempt => attempt.kind === 'ci' && attempt.outcome === 'succeeded')
    && !attempts.some(attempt => attempt.kind === 'promotion')
  if (!faultBound) throw new Error('FaultRecord does not authorize one fault-bound promotion')
}
const record = releaseRecord(JSON.parse(await readFile(recordPath, 'utf8')))
const snapshot = rolloutSnapshot(JSON.parse(await readFile(snapshotPath, 'utf8')))
const proposedRevisions = [...record.pendingRevisions, candidate]
const decision = rolloutDecision({
  stableRevision: record.stableRevision,
  proposedRevisions,
  activeProductPullRequests: snapshot.activeProductPullRequests,
  faultBound,
})
const next = decision.action === 'defer'
  ? { version: 1, stableRevision: record.stableRevision, pendingRevisions: [decision.pendingRevision] }
  : decision.action === 'promote'
    ? { version: 1, stableRevision: decision.stableRevision, pendingRevisions: [] }
    : record
const temporaryPath = `${recordPath}.${randomUUID()}.tmp`
try {
  await writeFile(temporaryPath, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
  await rename(temporaryPath, recordPath)
} finally {
  await rm(temporaryPath, { force: true })
}
if (decision.supersededRevisions?.length) {
  process.stdout.write(`superseded pending controller revisions: ${decision.supersededRevisions.join(', ')}\n`)
}
process.stdout.write(`${decision.action}: stable controller revision ${next.stableRevision}\n`)
