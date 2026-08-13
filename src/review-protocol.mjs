/** Parse the hidden machine payload from a human-readable Codex final answer. */
export function parseReviewMessage(message) {
  const match = message.match(/<!-- dsh-review-result\r?\n([\s\S]*?)\r?\n-->\s*$/)
  if (!match) throw new Error('Codex final answer does not end with the hidden review result')
  let value
  try {
    value = JSON.parse(match[1])
  } catch (error) {
    throw new Error(`Codex hidden review result is not valid JSON: ${error.message}`, { cause: error })
  }
  return validateReview(value)
}

/** Validate the fail-closed review payload consumed by GitHub automation. */
export function validateReview(value) {
  if (!value || !['pass', 'block'].includes(value.verdict) || typeof value.summary !== 'string'
    || !value.summary.trim() || value.summary.length > 4000 || !Array.isArray(value.findings)
    || value.findings.length > 30) {
    throw new Error('Codex returned an invalid review object')
  }
  for (const finding of value.findings) {
    if (!['P0', 'P1'].includes(finding.priority)
      || typeof finding.title !== 'string'
      || !finding.title.trim()
      || finding.title.length > 200
      || typeof finding.body !== 'string'
      || !finding.body.trim()
      || finding.body.length > 4000
      || typeof finding.path !== 'string'
      || !finding.path.trim()
      || finding.path.length > 500
      || !Number.isInteger(finding.line)
      || finding.line < 1) {
      throw new Error('Codex returned an invalid blocking finding')
    }
  }
  if (value.verdict === 'pass' && value.findings.length > 0) {
    throw new Error('A passing review cannot contain blocking findings')
  }
  if (value.verdict === 'block' && value.findings.length === 0) {
    throw new Error('A blocking review must contain at least one finding')
  }
  return value
}

/** Render the English GitHub review body for one exact commit. */
export function githubReviewBody(review, { marker, base, head }) {
  const lines = [
    marker,
    `## Codex review: ${review.verdict === 'pass' ? 'PASS' : 'BLOCK'}`,
    '',
    review.summary.trim(),
  ]
  if (review.findings.length > 0) {
    lines.push('', '### Blocking findings', '')
    for (const finding of review.findings) {
      lines.push(`- **[${finding.priority}] ${finding.title}** — \`${finding.path}:${finding.line}\`: ${finding.body}`)
    }
  }
  lines.push('', `_Reviewed exact head \`${head}\` against base \`${base}\` with gpt-5.6-sol (medium)._`)
  return lines.join('\n')
}

