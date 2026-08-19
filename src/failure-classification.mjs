import { createHash } from 'node:crypto'
import { intentionalReviewBlock, trustedFailedAgentRun } from './recovery-policy.mjs'
import { trustedCiFailure } from './dispatch-policy.mjs'

/** Controller-owned failure categories used by recovery and health projections. */
export const FAILURE_CATEGORIES = Object.freeze([
  'implementation', 'review', 'ci-environment', 'orchestration', 'unknown',
])

const TRANSPORT_PATTERN = /\b(?:ECONNRESET|ECONNREFUSED|EAI_AGAIN|ETIMEDOUT|UND_ERR_SOCKET|network|socket|timed out|cancelled)\b/i
const AUTH_QUOTA_PATTERN = /\b(?:401|403|unauthori[sz]ed|authentication|credential|quota|rate limit|insufficient credits?|billing)\b/i
const PROTOCOL_PATTERN = /\b(?:invalid (?:JSON|RPC|receipt|automation result)|malformed|unknown worker receipt outcome|without a terminal assistant message)\b/i
const HOST_PATTERN = /\b(?:EBUSY|EPERM)\b|resource busy or locked|app server.{0,80}(?:did not exit|shutdown|timed out)|review workspace.{0,80}(?:lease|locked)/i
const QUALIFIED_FAILURES = new Set(['failure', 'timed_out', 'startup_failure', 'stale'])
const MAX_EVIDENCE_JOBS = 20
const MAX_EVIDENCE_STEPS = 20
const MAX_EVIDENCE_TEXT = 200
const VERIFIED_ROLES = new WeakSet()

/** @typedef {'target-required-ci' | 'agent-review' | 'dsh-change' | 'dsh-repair' | 'controller-orchestration'} VerifiedFailureRoleKind */
/** @typedef {{ kind: VerifiedFailureRoleKind, repository: string, controllerSha?: string, workflowName?: string, workflowPath?: string }} VerifiedFailureRole */

/** @param {VerifiedFailureRole} value @returns {VerifiedFailureRole} */
function verifiedRole(value) {
  const role = Object.freeze(value)
  VERIFIED_ROLES.add(role)
  return role
}

/** Verify one existing Agent workflow and return its closed failure-classification role. @param {object} input @returns {VerifiedFailureRole | null} */
export function verifyAgentFailureRole({ run, repository, trust }) {
  const subjectRole = trustedFailedAgentRun({ run, repository, trust })
  const kind = subjectRole === 'review' ? 'agent-review' : subjectRole === 'issue' ? 'dsh-change' : subjectRole === 'pull-request' ? 'dsh-repair' : null
  if (!kind) return null
  return verifiedRole({ kind, repository, controllerSha: trust.controllerSha })
}

/** Verify one configured target required-CI failure and return its closed role. @param {object} input @returns {VerifiedFailureRole | null} */
export function verifyTargetCiFailureRole({ run, pullRequestNumber, expectedHead, workflowName, repository }) {
  if (run?.repository?.full_name !== repository || !trustedCiFailure({ run, pullRequestNumber, expectedHead, workflowName })) return null
  return verifiedRole({ kind: 'target-required-ci', repository, workflowName })
}

/** Verify one immutable reusable Controller workflow reference and return its orchestration role. @param {object} input @returns {VerifiedFailureRole | null} */
export function verifyControllerOrchestrationRole({ run, repository, controllerRepository, controllerSha, workflowPath }) {
  const expected = `${controllerRepository}/${workflowPath}@${controllerSha}`
  if (run?.repository?.full_name !== repository || run.status !== 'completed'
    || !run.referenced_workflows?.some(reference => reference.path === expected && reference.sha === controllerSha)) return null
  return verifiedRole({ kind: 'controller-orchestration', repository, controllerSha, workflowPath })
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

function failureEvidence(run, jobs) {
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
  return { category: 'unknown', reason, evidence: failureEvidence(run, jobs) }
}

/**
 * Classify trusted workflow failure evidence without accepting a model-supplied category.
 *
 * @param {object} input Trusted workflow and job evidence.
 * @returns {{category: string, reason: string, evidence: object}}
 */
export function classifyControllerFailure({ run, jobs, provenance, failureClass } = {}) {
  if (!provenance || !VERIFIED_ROLES.has(provenance)) {
    return unknownFailure(run, jobs, 'failure role is not controller-verified')
  }
  if (!run || typeof run !== 'object' || !Array.isArray(jobs)) {
    return unknownFailure(run, jobs, 'workflow failure evidence is incomplete')
  }
  if (!hasTerminalFailure(run, jobs)) return unknownFailure(run, jobs, 'workflow has no trusted terminal failure evidence')

  const evidence = failureEvidence(run, jobs)
  if (provenance.kind === 'agent-review' && intentionalReviewBlock(run, jobs)) {
    return { category: 'review', reason: 'trusted review worker published an intentional BLOCK', evidence }
  }

  if (['transport', 'host', 'auth-quota'].includes(failureClass)) {
    return { category: 'ci-environment', reason: `trusted runner or provider failure: ${failureClass}`, evidence }
  }
  if (['protocol', 'permissions'].includes(failureClass)) {
    return { category: 'orchestration', reason: `trusted controller protocol failure: ${failureClass}`, evidence }
  }
  if (provenance.kind === 'target-required-ci') {
    return { category: 'implementation', reason: 'trusted required CI reported a target failure', evidence }
  }
  if (failureClass === 'task' && ['dsh-change', 'dsh-repair'].includes(provenance.kind)) {
    return { category: 'implementation', reason: 'trusted target task failed', evidence }
  }
  if (provenance.kind === 'controller-orchestration') {
    return { category: 'orchestration', reason: 'trusted controller workflow failed', evidence }
  }
  return unknownFailure(run, jobs, 'trusted evidence does not identify a supported failure class')
}
