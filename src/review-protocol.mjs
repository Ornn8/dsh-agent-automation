/** Return the durable idempotency key for one exact blocked review pair. */
export function automaticRepairRequestId(base, head) {
  if (![base, head].every(value => /^[0-9a-f]{40}$/i.test(value))) {
    throw new Error('Automatic repair requests require full commit SHAs')
  }
  return `codex-${base.toLowerCase()}-${head.toLowerCase()}`
}

/** Return whether GitHub already records an automated verdict for this exact head. */
export function hasExactReviewVerdict(comments, head, authorLogin = 'github-actions[bot]') {
  const marker = `<!-- codex-review:${head} -->`
  return comments.some(comment => comment.user?.login === authorLogin && comment.body?.includes(marker))
}

/** Parse the hidden machine payload from a human-readable Codex final answer. */
export function parseReviewMessage(message) {
  const match = message.match(/<details>\r?\n<summary>Automation result<\/summary>\r?\n\r?\n```json\r?\n([\s\S]*?)\r?\n```\r?\n<\/details>\s*$/)
    || message.match(/<!-- dsh-review-result\r?\n([\s\S]*?)\r?\n-->\s*$/)
  if (!match) throw new Error('Codex final answer does not end with the automation result')
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
    || !englishLine(value.summary, 4000) || !Array.isArray(value.findings)
    || value.findings.length > 30) {
    throw new Error('Codex returned an invalid review object')
  }
  for (const finding of value.findings) {
    if (!['P0', 'P1'].includes(finding.priority)
      || typeof finding.title !== 'string'
      || !englishLine(finding.title, 200)
      || typeof finding.body !== 'string'
      || !englishLine(finding.body, 4000)
      || typeof finding.path !== 'string'
      || !repositoryPath(finding.path)
      || !Number.isInteger(finding.line)
      || finding.line < 1
      || typeof finding.excerpt !== 'string'
      || !englishLine(finding.excerpt, 500)) {
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

function englishLine(value, limit) {
  return Boolean(value.trim()) && value.length <= limit && /^[\x20-\x7E]+$/.test(value)
}

function repositoryPath(value) {
  if (!value.trim() || value.length > 500 || value.startsWith('/')
    || /[`\\\r\n]/.test(value)) return false
  const segments = value.split('/')
  return segments.every(segment => segment && segment !== '.' && segment !== '..')
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
