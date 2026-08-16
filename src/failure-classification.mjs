const TRANSPORT_PATTERN = /\b(?:ECONNRESET|ECONNREFUSED|EAI_AGAIN|ETIMEDOUT|UND_ERR_SOCKET|network|socket|timed out|cancelled)\b/i
const AUTH_QUOTA_PATTERN = /\b(?:401|403|unauthori[sz]ed|authentication|credential|quota|rate limit|insufficient credits?|billing)\b/i
const PROTOCOL_PATTERN = /\b(?:invalid (?:JSON|RPC|receipt|automation result)|malformed|unknown worker receipt outcome|without a terminal assistant message)\b/i

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
  if (TRANSPORT_PATTERN.test(text)) return 'transport'
  return 'task'
}

/** Read a controller-authored failure class from one durable status comment. */
export function recordedFailureClass(body) {
  return /^- Failure class: `(transport|auth-quota|protocol|task)`$/m.exec(String(body || ''))?.[1] || null
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
import { createHash } from 'node:crypto'
