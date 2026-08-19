const RESULT_PREFIX = 'agent-landing-result:'

/** Parse the bounded machine result emitted by the deterministic landing command. */
export function landingResult(output) {
  const matches = String(output || '').match(/agent-landing-result:(landed|deferred)\b/g)
  if (!matches || matches.length !== 1) throw new Error('Landing command did not emit one machine result')
  return { outcome: matches[0].slice(RESULT_PREFIX.length) }
}

/** Emit one machine result after the human-readable landing diagnostic. */
export function writeLandingResult(outcome) {
  if (!['landed', 'deferred'].includes(outcome)) throw new Error('Landing result is invalid')
  process.stdout.write(`${RESULT_PREFIX}${outcome}\n`)
}
