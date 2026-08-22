// @ts-check

import { createHash } from 'node:crypto'
import {
  authenticatedMarker, hostCredentialEnvironment, loadConfig, parseJson, requiredEnv, run, trustedAssociation,
} from './common.mjs'
import { agentWorkRequestId, parseAgentWork } from './agent-work.mjs'
import { createCapacityRegistry } from './capacity-registry-store.mjs'
import { evaluateCapacityWaitResumeAndDispatch } from './capacity-resume-policy.mjs'
import { parseCapacityWaitStatus } from './capacity-wait-projection.mjs'
import { issueGovernorSubject } from './governor-state.mjs'
import { subjectStateVersion } from './governor-policy.mjs'
import { createLocalWorkerRoutingExecution } from './worker-routing.mjs'
import { loadTrustedWorkflowProfile, resolveWorkflowStage } from './workflow-profile.mjs'
import { createIssueImplementationRequest } from './work-request.mjs'
import { resolveWorkerCandidates } from './machine-config.mjs'

/** @typedef {Record<string, any>} AnyObject */

const repository = requiredEnv('TARGET_REPOSITORY')
const config = await loadConfig()
const marker = '<!-- agent-worker-run -->'
const markerAuthor = config.github.login
const environment = hostCredentialEnvironment()
if (!config.repositories.includes(repository)) throw new Error(`${repository} is not in the runner allowlist`)

/** @param {string[]} args @param {string} description @returns {Promise<any>} */
async function ghJson(args, description) {
  return parseJson((await run(config.ghExecutable, args, { env: environment })).stdout, description)
}

/** @param {string} path @param {string} description @returns {Promise<AnyObject[]>} */
async function pages(path, description) {
  return (await ghJson(['api', path, '--paginate', '--slurp'], description)).flat()
}

/** @param {string} profileId @param {string} revision @returns {Promise<AnyObject>} */
async function profileAt(profileId, revision) {
  return loadTrustedWorkflowProfile({
    repository, revision, profileId,
    loadContent: /** @param {{ path: string, revision: string }} input */ async (input) => {
      const { path, revision: exactRevision } = input
      const content = await ghJson([
        'api', '--method', 'GET', `repos/${repository}/contents/${path}`, '-f', `ref=${exactRevision}`,
      ], `Profile ${profileId}`)
      if (content?.encoding !== 'base64' || typeof content.content !== 'string') throw new Error(`Profile ${profileId} is not a GitHub file`)
      return Buffer.from(content.content.replace(/\s/g, ''), 'base64').toString('utf8')
    },
  })
}

/** @param {AnyObject[]} comments @returns {AnyObject|null} */
function projectionFrom(comments) {
  const waiting = comments.filter(comment => authenticatedMarker(comment, marker, markerAuthor)
    && /^- Status: \*\*capacity-waiting\*\*$/m.test(comment.body || ''))
  if (waiting.length !== 1) return null
  try { return parseCapacityWaitStatus(waiting[0].body) } catch { return null }
}

/** @param {AnyObject[]} plans @returns {string} */
function generationHash(plans) {
  return createHash('sha256').update(JSON.stringify(plans)).digest('hex')
}

/** @param {AnyObject} issue @param {AnyObject} projection @param {string} base @returns {Promise<AnyObject|null>} */
async function currentRequest(issue, projection, base) {
  const work = parseAgentWork(issue.body)
  if (!work || work.dispatch !== 'ready' || work.profile !== projection.profileId || work.workflow !== projection.workflowId) return null
  const profile = await profileAt(projection.profileId, base)
  const requestId = agentWorkRequestId(work, profile.definitionHash)
  return {
    request: createIssueImplementationRequest({
      ...profile, definition: profile.definition, definitionHash: profile.definitionHash,
      workflowId: work.workflow, repository, issueNumber: issue.number, base, requestId,
    }),
    profile,
    work,
  }
}

/** @param {AnyObject} routeDecision @param {number} now @returns {Promise<AnyObject>} */
async function inspectCapacity(routeDecision, now) {
  const candidates = resolveWorkerCandidates({ config, role: 'change', routeDecision })
  const registry = createCapacityRegistry({
    stateRoot: config.operations.stateRoot,
    configurationHash: config.configurationHash,
    credentialGeneration: config.credentialGeneration,
    workers: config.workers,
  })
  const plans = await Promise.all(candidates.map(workerId => registry.inspect({ workerId, now })))
  return { generationHash: generationHash(plans), plans }
}

/** @param {AnyObject} issue @param {AnyObject} projection @param {string} base @returns {Promise<boolean>} */
async function wake(issue, projection, base) {
  const labels = new Set((issue.labels || []).map(/** @param {AnyObject} label */ label => label.name))
  if (projection.repository !== repository || projection.subject.type !== 'issue'
    || projection.subject.number !== issue.number || issue.state !== 'open'
    || !trustedAssociation(issue.author_association) || !labels.has('agent/dsh')
    || ['automation/paused', 'agent/dsh-failed', 'agent/dsh-blocked'].some(label => labels.has(label))) return false
  const rebuilt = await currentRequest(issue, projection, base)
  if (!rebuilt) return false
  const subject = issueGovernorSubject(issue)
  const stateVersion = subjectStateVersion(subject)
  const routeDecision = createLocalWorkerRoutingExecution({
    workRequest: rebuilt.request,
    subjectState: subject,
    subjectStateVersion: stateVersion,
    trustedTaskSnapshot: { workflowStage: rebuilt.request.stageId, labels: issue.labels, title: issue.title, body: issue.body },
    routingPolicy: config.operations.routing.change,
  }).routeDecision
  resolveWorkflowStage(rebuilt.profile.definition, rebuilt.request.workflowId, rebuilt.request.stageId, 'worker')
  const capacitySnapshot = await inspectCapacity(routeDecision, Date.now())
  const currentSubject = { type: 'issue', number: issue.number, stateVersion, revision: rebuilt.request.revision }
  const result = await evaluateCapacityWaitResumeAndDispatch({
    projection, workRequest: rebuilt.request, profile: rebuilt.profile, currentSubject,
    currentRouteDecision: routeDecision, machineConfig: config, capacitySnapshot, now: Date.now(),
    /** @param {AnyObject} payload */
    dispatch: payload => run(config.ghExecutable, ['api', '--method', 'POST', `repos/${repository}/dispatches`, '--input', '-'], {
      env: environment, input: JSON.stringify(payload),
    }),
  })
  if (result.dispatched) process.stdout.write(`Resumed Issue #${issue.number} with ${result.decision.capacityResumeRequestId}.\n`)
  return result.dispatched
}

const repositoryState = await ghJson(['api', `repos/${repository}`], 'repository state')
const defaultBranch = repositoryState.default_branch
const base = (await ghJson(['api', `repos/${repository}/commits/${encodeURIComponent(defaultBranch)}`], 'default branch')).sha
const issues = (await pages(`repos/${repository}/issues?state=open&per_page=100`, 'open Issues'))
  .filter(/** @param {AnyObject} issue */ issue => !issue.pull_request
    && issue.labels?.some(/** @param {AnyObject} label */ label => label.name === 'agent/dsh'))
  .sort((left, right) => left.number - right.number)
for (const issue of issues) {
  const projection = projectionFrom(await pages(`repos/${repository}/issues/${issue.number}/comments?per_page=100`, `Issue #${issue.number} comments`))
  if (!projection) continue
  if (await wake(issue, projection, base)) break
}
