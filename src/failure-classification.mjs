import { createHash } from 'node:crypto'
import { validateRepositoryAutomationConfig } from './common.mjs'
import { recordedReviewFailure } from './fault-observation.mjs'
import { GOVERNOR_WORKFLOW_PATHS } from './governor-state.mjs'
import { hasTrustedExactReviewRun, reviewRunIdFromCheckRun } from './landing-policy.mjs'
import { intentionalReviewBlock, trustedFailedAgentRun } from './recovery-policy.mjs'
import { trustedCiFailure } from './dispatch-policy.mjs'

/** Controller-owned failure categories used by recovery and health projections. */
export const FAILURE_CATEGORIES = Object.freeze([
  'implementation', 'review', 'ci-environment', 'orchestration', 'review-evidence-disagreement', 'unknown',
])

const TRANSPORT_PATTERN = /\b(?:ECONNRESET|ECONNREFUSED|EAI_AGAIN|ETIMEDOUT|UND_ERR_SOCKET|network|socket|timed out|cancelled)\b/i
const AUTH_QUOTA_PATTERN = /\b(?:401|403|unauthori[sz]ed|authentication|credential|quota|rate limit|insufficient credits?|billing)\b/i
const PROTOCOL_PATTERN = /\b(?:invalid (?:JSON|RPC|receipt|automation result)|malformed|unknown worker receipt outcome|without a terminal assistant message)\b/i
const HOST_PATTERN = /\b(?:EBUSY|EPERM)\b|resource busy or locked|app server.{0,80}(?:did not exit|shutdown|timed out)|review workspace.{0,80}(?:lease|locked)/i
const QUALIFIED_FAILURES = new Set(['failure', 'timed_out', 'startup_failure', 'stale'])
const MAX_EVIDENCE_JOBS = 20
const MAX_EVIDENCE_STEPS = 20
const MAX_EVIDENCE_TEXT = 200
const FULL_SHA = /^[0-9a-f]{40}$/
const GITHUB_ACTIONS_APP_ID = 15368
const CONTROLLER_ORCHESTRATION_PATHS = new Set([
  ...GOVERNOR_WORKFLOW_PATHS.filter(path => ![
    '.github/workflows/agent-review.yml',
    '.github/workflows/dsh-repair.yml',
  ].includes(path)),
  '.github/workflows/controller-maintenance-readiness.yml',
  '.github/workflows/controller-maintenance.yml',
  '.github/workflows/land-pr.yml',
  '.github/workflows/observe-agent-fault.yml',
  '.github/workflows/pipeline-health.yml',
  '.github/workflows/reconcile-landing.yml',
  '.github/workflows/runner-watchdog.yml',
])
const VERIFIED_ROLES = new WeakSet()
const VERIFIED_FAILURE_EVIDENCE = new WeakSet()

/** @typedef {'target-required-ci' | 'agent-review' | 'controller-orchestration'} VerifiedFailureRoleKind */
/** @typedef {{ kind: VerifiedFailureRoleKind, repository: string, evidenceSignature: string, controllerSha?: string, workflowName?: string, workflowPath?: string }} VerifiedFailureRole */
/** @typedef {{ failureClass: string, evidenceSignature: string, roleKind: VerifiedFailureRoleKind, source: string }} VerifiedFailureEvidence */

function normalizedWorkflowEvidence(run, jobs) {
  if (!Number.isSafeInteger(run?.id) || run.id < 1
    || typeof run.repository?.full_name !== 'string' || !run.repository.full_name
    || !Array.isArray(jobs)) return null
  const normalizedJobs = []
  const jobIds = new Set()
  for (const job of jobs) {
    if (!Number.isSafeInteger(job?.id) || job.id < 1 || jobIds.has(job.id)) return null
    jobIds.add(job.id)
    const steps = []
    const stepNumbers = new Set()
    for (const step of Array.isArray(job.steps) ? job.steps : []) {
      if (!Number.isSafeInteger(step?.number) || step.number < 1 || stepNumbers.has(step.number)) return null
      stepNumbers.add(step.number)
      steps.push({
        number: step.number,
        name: String(step.name || ''),
        status: String(step.status || ''),
        conclusion: String(step.conclusion || ''),
      })
    }
    steps.sort((left, right) => left.number - right.number)
    normalizedJobs.push({
      id: job.id,
      name: String(job.name || ''),
      status: String(job.status || ''),
      conclusion: String(job.conclusion || ''),
      steps,
    })
  }
  normalizedJobs.sort((left, right) => left.id - right.id)
  const pullRequests = (Array.isArray(run.pull_requests) ? run.pull_requests : []).map(pullRequest => ({
    number: Number.isSafeInteger(pullRequest?.number) ? pullRequest.number : null,
    base: String(pullRequest?.base?.sha || ''),
    head: String(pullRequest?.head?.sha || ''),
  })).sort((left, right) => (left.number || 0) - (right.number || 0))
  const referencedWorkflows = (Array.isArray(run.referenced_workflows) ? run.referenced_workflows : []).map(reference => ({
    path: String(reference?.path || ''),
    sha: String(reference?.sha || ''),
  })).sort((left, right) => left.path.localeCompare(right.path) || left.sha.localeCompare(right.sha))
  return {
    run: {
      id: run.id,
      attempt: Number.isSafeInteger(run.run_attempt) ? run.run_attempt : 1,
      repository: run.repository.full_name,
      name: String(run.name || ''),
      path: String(run.path || ''),
      event: String(run.event || ''),
      status: String(run.status || ''),
      conclusion: String(run.conclusion || ''),
      head: String(run.head_sha || ''),
      branch: String(run.head_branch || ''),
      pullRequests,
      referencedWorkflows,
    },
    jobs: normalizedJobs,
  }
}

function workflowEvidenceIdentity(run, jobs) {
  const normalized = normalizedWorkflowEvidence(run, jobs)
  return normalized ? createHash('sha256').update(JSON.stringify(normalized)).digest('hex') : null
}

function actionsRunIdFromDetailsUrl(detailsUrl, repository) {
  try {
    const url = new URL(detailsUrl)
    const match = /^\/([^/]+\/[^/]+)\/actions\/runs\/([1-9][0-9]*)(?:\/job\/[1-9][0-9]*)?$/.exec(url.pathname)
    const runId = Number.parseInt(match?.[2] || '', 10)
    return url.protocol === 'https:' && url.hostname === 'github.com' && match?.[1] === repository && Number.isSafeInteger(runId)
      ? runId : null
  } catch {
    return null
  }
}

/** @param {Omit<VerifiedFailureRole, 'evidenceSignature'>} value @param {object} run @param {object[]} jobs @returns {VerifiedFailureRole | null} */
function verifiedRole(value, run, jobs) {
  const evidenceSignature = workflowEvidenceIdentity(run, jobs)
  if (!evidenceSignature) return null
  const role = Object.freeze({ ...value, evidenceSignature })
  VERIFIED_ROLES.add(role)
  return role
}

/** @param {Omit<VerifiedFailureEvidence, 'evidenceSignature' | 'roleKind'>} value @param {object} run @param {object[]} jobs @param {VerifiedFailureRole} provenance @returns {VerifiedFailureEvidence | null} */
function verifiedFailureEvidence(value, run, jobs, provenance) {
  if (!verifiedForEvidence(provenance, VERIFIED_ROLES, run, jobs)) return null
  const evidenceSignature = workflowEvidenceIdentity(run, jobs)
  if (!evidenceSignature) return null
  const evidence = Object.freeze({ ...value, roleKind: provenance.kind, evidenceSignature })
  VERIFIED_FAILURE_EVIDENCE.add(evidence)
  return evidence
}

function verifiedForEvidence(value, registry, run, jobs) {
  return value && registry.has(value) && value.evidenceSignature === workflowEvidenceIdentity(run, jobs)
}

/** Verify one existing Agent workflow and return its closed failure-classification role. @param {object} input @returns {VerifiedFailureRole | null} */
export function verifyAgentFailureRole({ run, jobs, repository, trust }) {
  const subjectRole = trustedFailedAgentRun({ run, repository, trust })
  if (subjectRole !== 'review') return null
  return verifiedRole({ kind: 'agent-review', repository, controllerSha: trust.controllerSha }, run, jobs)
}

/** Verify one target required-CI failure against trusted machine configuration and a caller-owned static workflow route. @param {object} input @returns {VerifiedFailureRole | null} @throws {Error} Invalid machine configuration. */
export function verifyTargetCiFailureRole({ run, jobs, checkRun, config, repository, workflowName, workflowPath, requiredCheckName, subject }) {
  validateRepositoryAutomationConfig(config)
  const mappings = config.operations.repositoryMappings.filter(mapping => mapping.repository === repository)
  if (mappings.length !== 1
    || !mappings[0].ciWorkflows.includes(workflowName)
    || !mappings[0].requiredChecks.includes(requiredCheckName)
    || !/^\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml$/.test(workflowPath || '')
    || repository !== run?.repository?.full_name
    || !Number.isSafeInteger(subject?.pullRequestNumber) || subject.pullRequestNumber < 1
    || !FULL_SHA.test(subject?.expectedHead || '')
    || run.path !== workflowPath
    || !trustedCiFailure({
      run,
      pullRequestNumber: subject.pullRequestNumber,
      expectedHead: subject.expectedHead,
      workflowName,
    })
    || !Number.isSafeInteger(checkRun?.id) || checkRun.id < 1
    || checkRun.name !== requiredCheckName
    || checkRun.app?.id !== GITHUB_ACTIONS_APP_ID
    || checkRun.status !== 'completed'
    || checkRun.conclusion !== 'failure'
    || checkRun.head_sha !== subject.expectedHead
    || actionsRunIdFromDetailsUrl(checkRun.details_url, repository) !== run.id) return null
  return verifiedRole({
    kind: 'target-required-ci',
    repository,
    workflowName,
    workflowPath,
  }, run, jobs)
}

/** Verify one immutable reusable Controller workflow reference and return its orchestration role. @param {object} input @returns {VerifiedFailureRole | null} */
export function verifyControllerOrchestrationRole({ run, jobs, repository, controllerRepository, controllerSha, workflowPath }) {
  const expected = `${controllerRepository}/${workflowPath}@${controllerSha}`
  if (run?.repository?.full_name !== repository || run.status !== 'completed'
    || !FULL_SHA.test(controllerSha || '')
    || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(controllerRepository || '')
    || !CONTROLLER_ORCHESTRATION_PATHS.has(workflowPath)
    || !run.referenced_workflows?.some(reference => reference.path === expected && reference.sha === controllerSha)) return null
  return verifiedRole({ kind: 'controller-orchestration', repository, controllerSha, workflowPath }, run, jobs)
}

function boundedEvidenceText(value) {
  return String(value || '').slice(0, MAX_EVIDENCE_TEXT)
}

/** Classify an Agent failure for bounded recovery without trusting model output. */
export function classifyAgentFailure(error) {
  const messages = []
  for (let current = error; current && !messages.includes(String(current.message || current)); current = current.cause) {
    messages.push(String(current.message || current))
    if (current.kind === 'transient') return 'transport'
  }
  const text = messages.join(' ')
  if (AUTH_QUOTA_PATTERN.test(text)) return 'auth-quota'
  if (PROTOCOL_PATTERN.test(text)) return 'protocol'
  if (HOST_PATTERN.test(text)) return 'host'
  if (TRANSPORT_PATTERN.test(text)) return 'transport'
  return 'task'
}

/** Derive exact review-infrastructure evidence without trusting a recorded or model-provided class. @param {object} input @returns {VerifiedFailureEvidence | null} */
export function verifyReviewInfrastructureFailureEvidence({ run, jobs, provenance }) {
  if (!verifiedForEvidence(provenance, VERIFIED_ROLES, run, jobs)
    || provenance.kind !== 'agent-review'
    || intentionalReviewBlock(run, jobs)) return null
  const failureClass = ['cancelled', 'timed_out', 'startup_failure', 'stale'].includes(run.conclusion) ? 'transport' : 'host'
  return verifiedFailureEvidence({ failureClass, source: 'review-workflow' }, run, jobs, provenance)
}

/** Verify one Actions-owned review failure record and bind its class to the source run evidence. @param {object} input @returns {VerifiedFailureEvidence | null} */
export function verifyRecordedReviewFailureEvidence({ run, jobs, provenance, checkRuns, repository }) {
  if (!verifiedForEvidence(provenance, VERIFIED_ROLES, run, jobs) || provenance.kind !== 'agent-review') return null
  const recorded = recordedReviewFailure(checkRuns, run.id, repository)
  return recorded ? verifiedFailureEvidence({ failureClass: recorded.failureClass, source: 'review-check-run' }, run, jobs, provenance) : null
}

/** Verify a contradiction between one trusted review workflow failure and its Actions-owned CheckRun. @param {object} input @returns {VerifiedFailureEvidence | null} */
export function verifyReviewEvidenceDisagreement({ run, jobs, provenance, pullRequest, reviewProof, trustedReview }) {
  const checkRun = reviewProof?.checkRun
  if (!verifiedForEvidence(provenance, VERIFIED_ROLES, run, jobs)
    || provenance.kind !== 'agent-review'
    || !FULL_SHA.test(pullRequest?.baseRefOid || '')
    || !FULL_SHA.test(pullRequest?.headRefOid || '')
    || checkRun?.head_sha !== pullRequest.headRefOid
    || workflowEvidenceIdentity(reviewProof?.run, jobs) !== provenance.evidenceSignature
    || !hasTrustedExactReviewRun({ pullRequest, reviewProof, trustedReview })
    || String(checkRun.conclusion).toUpperCase() !== 'SUCCESS'
    || run.conclusion !== 'failure'
    || reviewProof.run.id !== run.id) return null
  return verifiedFailureEvidence({
    failureClass: 'review-evidence-disagreement',
    source: 'review-check-run-disagreement',
  }, run, jobs, provenance)
}

/** Return one stable non-secret error identity for a classified Agent failure. */
export function agentFailureCode(error, failureClass = classifyAgentFailure(error)) {
  const messages = []
  for (let current = error; current && !messages.includes(String(current.message || current)); current = current.cause) {
    messages.push(String(current.message || current))
  }
  const text = messages.join(' ')
  if (/\b(?:EBUSY|EPERM)\b|resource busy or locked/i.test(text)) return 'review-workspace-busy'
  if (/app server.{0,80}(?:did not exit|shutdown|timed out)|reviewer process.{0,80}(?:did not exit|timed out)/i.test(text)) return 'reviewer-process-exit'
  if (/review workspace.{0,80}(?:lease|locked)/i.test(text)) return 'review-workspace-lease'
  return `${failureClass}-failure`
}

/** Read a controller-authored failure class from one durable status comment. */
export function recordedFailureClass(body) {
  return /^- Failure class: `(transport|auth-quota|protocol|task|host|permissions)`$/m.exec(String(body || ''))?.[1] || null
}

/** Build a stable failure signature from trusted workflow job and step conclusions. */
export function workflowFailureSignature(run, jobs) {
  if (!run || typeof run !== 'object' || !Array.isArray(jobs)) throw new Error('workflow failure evidence is invalid')
  const failures = jobs.flatMap(job => {
    const steps = Array.isArray(job.steps) ? job.steps : []
    const failedSteps = steps
      .filter(step => !['success', 'skipped', 'neutral'].includes(String(step.conclusion || '').toLowerCase()))
      .map(step => ({
        name: String(step.name || ''),
        number: Number.isSafeInteger(step.number) ? step.number : 0,
        conclusion: String(step.conclusion || ''),
      }))
    if (!failedSteps.length && ['success', 'skipped', 'neutral'].includes(String(job.conclusion || '').toLowerCase())) return []
    return [{ name: String(job.name || ''), conclusion: String(job.conclusion || ''), steps: failedSteps }]
  }).sort((left, right) => left.name.localeCompare(right.name))
  const evidence = {
    workflow: String(run.name || ''),
    event: String(run.event || ''),
    conclusion: String(run.conclusion || ''),
    failures,
  }
  return `workflow:${createHash('sha256').update(JSON.stringify(evidence)).digest('hex')}`
}

function auditFailureEvidence(run, jobs) {
  const candidates = (Array.isArray(jobs) ? jobs : []).flatMap(job => {
    const steps = (Array.isArray(job.steps) ? job.steps : [])
      .filter(step => QUALIFIED_FAILURES.has(String(step.conclusion || '').toLowerCase()))
    if (!steps.length && !QUALIFIED_FAILURES.has(String(job.conclusion || '').toLowerCase())) return []
    const failedSteps = steps.slice(0, MAX_EVIDENCE_STEPS).map(step => boundedEvidenceText(step.name))
    const omittedStepCount = Math.max(0, steps.length - failedSteps.length)
    return [{
      name: boundedEvidenceText(job.name),
      conclusion: boundedEvidenceText(job.conclusion),
      failedSteps,
      ...(omittedStepCount ? { omittedStepCount } : {}),
    }]
  })
  const failedJobs = candidates.slice(0, MAX_EVIDENCE_JOBS)
  const omittedJobCount = Math.max(0, candidates.length - failedJobs.length)
  return {
    runId: Number.isSafeInteger(run?.id) ? run.id : null,
    signature: workflowEvidenceIdentity(run, jobs),
    workflow: boundedEvidenceText(run?.name),
    event: boundedEvidenceText(run?.event),
    conclusion: boundedEvidenceText(run?.conclusion),
    failedJobs,
    ...(omittedJobCount ? { omittedJobCount } : {}),
  }
}

function hasTerminalFailure(run, jobs) {
  if (run?.status !== 'completed' || !['failure', 'cancelled', 'timed_out', 'startup_failure', 'stale'].includes(run.conclusion)) return false
  return jobs.some(job => QUALIFIED_FAILURES.has(String(job.conclusion || '').toLowerCase())
    || job.steps?.some(step => QUALIFIED_FAILURES.has(String(step.conclusion || '').toLowerCase())))
}

function unknownFailure(run, jobs, reason) {
  return { category: 'unknown', reason, evidence: auditFailureEvidence(run, jobs) }
}

/**
 * Classify trusted workflow failure evidence without accepting a model-supplied category.
 *
 * @param {object} input Trusted workflow and job evidence.
 * @returns {{category: string, reason: string, evidence: object}}
 */
export function classifyControllerFailure({ run, jobs, provenance, failureEvidence } = {}) {
  if (!verifiedForEvidence(provenance, VERIFIED_ROLES, run, jobs)) {
    return unknownFailure(run, jobs, 'failure role is not controller-verified')
  }
  if (!run || typeof run !== 'object' || !Array.isArray(jobs)) {
    return unknownFailure(run, jobs, 'workflow failure evidence is incomplete')
  }
  if (!hasTerminalFailure(run, jobs)) return unknownFailure(run, jobs, 'workflow has no trusted terminal failure evidence')
  if (failureEvidence !== undefined && (!verifiedForEvidence(failureEvidence, VERIFIED_FAILURE_EVIDENCE, run, jobs)
    || failureEvidence.roleKind !== provenance.kind)) {
    return unknownFailure(run, jobs, 'failure evidence is not controller-verified for this workflow run')
  }

  const evidence = auditFailureEvidence(run, jobs)
  const verifiedFailureClass = failureEvidence?.failureClass
  if (verifiedFailureClass === 'review-evidence-disagreement') {
    return { category: 'review-evidence-disagreement', reason: 'trusted review workflow and CheckRun evidence disagree', evidence }
  }
  if (provenance.kind === 'agent-review' && intentionalReviewBlock(run, jobs)) {
    return { category: 'review', reason: 'trusted review worker published an intentional BLOCK', evidence }
  }

  if (['transport', 'host', 'auth-quota'].includes(verifiedFailureClass)) {
    return { category: 'ci-environment', reason: `trusted runner or provider failure: ${verifiedFailureClass}`, evidence }
  }
  if (['protocol', 'permissions'].includes(verifiedFailureClass)) {
    return { category: 'orchestration', reason: `trusted controller protocol failure: ${verifiedFailureClass}`, evidence }
  }
  if (provenance.kind === 'target-required-ci') {
    return { category: 'implementation', reason: 'trusted required CI reported a target failure', evidence }
  }
  if (provenance.kind === 'controller-orchestration') {
    return { category: 'orchestration', reason: 'trusted controller workflow failed', evidence }
  }
  return unknownFailure(run, jobs, 'trusted evidence does not identify a supported failure class')
}
