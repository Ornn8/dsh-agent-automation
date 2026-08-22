export const TARGET_PULL_REQUEST_FILES = 10
export const TARGET_PULL_REQUEST_CHANGED_LINES = 500
export const MAX_PULL_REQUEST_FILES = 40
export const MAX_PULL_REQUEST_CHANGED_LINES = 2_000

function count(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`)
  return value
}

function unit(value, singular, plural) {
  return `${value} ${value === 1 ? singular : plural}`
}

function numstatCount(value, name) {
  if (value === '-') return 0
  if (!/^\d+$/.test(value)) throw new Error(`git numstat has an invalid ${name} count`)
  return Number.parseInt(value, 10)
}

function stripCommentsAndFences(body) {
  const lines = String(body ?? '').replace(/<!--[\s\S]*?(?:-->|$)/g, '').split(/\r?\n/)
  const visible = []
  let fence = null
  for (const line of lines) {
    const marker = line.match(/^\s*(`{3,}|~{3,})/)
    if (!fence) {
      if (marker) {
        fence = { character: marker[1][0], length: marker[1].length }
        continue
      }
      visible.push(line)
      continue
    }
    const closing = line.match(/^\s*(`{3,}|~{3,})\s*$/)
    if (closing && closing[1][0] === fence.character && closing[1].length >= fence.length) fence = null
  }
  return visible.join('\n')
}

function splitRationale(body) {
  const lines = stripCommentsAndFences(body).split(/\r?\n/)
  const heading = /^\s*#{1,6}\s+split rationale\s*:?(?:\s+(.*?))?\s*$/i
  const start = lines.findIndex(line => heading.test(line))
  if (start < 0) return ''

  const match = lines[start].match(heading)
  const nextHeading = lines.findIndex((line, index) => index > start && /^\s*#{1,6}\s+\S/.test(line))
  const section = lines.slice(start + 1, nextHeading < 0 ? lines.length : nextHeading)
  if (match?.[1]) section.unshift(match[1])

  const rationale = section.join('\n').trim()
  if (!rationale || /^\[[^\]]+\]$/.test(rationale) || /^(?:none|n\/a|not applicable|todo|tbd)$/i.test(rationale)) {
    return ''
  }
  return rationale
}

/** Measure file and changed-line counts from git diff --numstat output. */
export function measureGitNumstat(output) {
  let files = 0
  let changedLines = 0
  for (const line of String(output).split(/\r?\n/)) {
    if (!line) continue
    const [additions, deletions, path] = line.split('\t', 3)
    if (!path) throw new Error('git numstat row is missing a path')
    files += 1
    changedLines += numstatCount(additions, 'addition') + numstatCount(deletions, 'deletion')
  }
  return { files, changedLines }
}

/** Evaluate whether one pull request fits the repository review budget. */
export function evaluatePullRequestSize({ files, changedLines, pullRequestBody = '' }) {
  files = count(files, 'files')
  changedLines = count(changedLines, 'changedLines')
  const measured = `actual ${unit(files, 'file', 'files')} and ${unit(changedLines, 'changed line', 'changed lines')}`
  const target = `target <=${TARGET_PULL_REQUEST_FILES} files and <=${TARGET_PULL_REQUEST_CHANGED_LINES} changed lines`
  const absolute = `absolute <=${MAX_PULL_REQUEST_FILES} files and <=${MAX_PULL_REQUEST_CHANGED_LINES} changed lines`
  if (files > MAX_PULL_REQUEST_FILES) {
    return {
      accepted: false,
      message: `Pull request size exceeds the absolute file cap: ${measured}; ${target}; ${absolute}. A split rationale cannot override the absolute cap.`,
    }
  }
  if (changedLines > MAX_PULL_REQUEST_CHANGED_LINES) {
    return {
      accepted: false,
      message: `Pull request size exceeds the absolute line cap: ${measured}; ${target}; ${absolute}. A split rationale cannot override the absolute cap.`,
    }
  }
  if (files > TARGET_PULL_REQUEST_FILES || changedLines > TARGET_PULL_REQUEST_CHANGED_LINES) {
    if (!splitRationale(pullRequestBody)) {
      return {
        accepted: false,
        message: `Pull request size exceeds the default target without a non-empty, auditable split rationale: ${measured}; ${target}; ${absolute}. Add a ## Split rationale section explaining why this change cannot be split.`,
      }
    }
    return { accepted: true, message: `Pull request size is reviewable with a split rationale: ${measured}; ${target}; ${absolute}.` }
  }
  return { accepted: true, message: `Pull request size is reviewable: ${measured}; ${target}; ${absolute}.` }
}
