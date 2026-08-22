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

function visibleMarkdownLines(body) {
  const lines = String(body ?? '').split(/\r?\n/)
  const visible = []
  let fence = null
  let commentOpen = false

  for (const line of lines) {
    if (fence) {
      const closing = line.match(/^ {0,3}(`{3,}|~{3,})[ \t]*$/)
      if (closing && closing[1][0] === fence.character && closing[1].length >= fence.length) fence = null
      continue
    }

    if (!commentOpen && !/^(?: {4,}|\t)/.test(line)) {
      const opening = line.match(/^ {0,3}(`{3,}|~{3,})(?:.*)$/)
      if (opening) {
        fence = { character: opening[1][0], length: opening[1].length }
        continue
      }
    }

    if (!commentOpen && /^(?: {4,}|\t)/.test(line)) continue

    let index = 0
    let output = ''
    while (index < line.length) {
      if (commentOpen) {
        const close = line.indexOf('-->', index)
        if (close < 0) {
          index = line.length
          break
        }
        commentOpen = false
        index = close + 3
        continue
      }

      const open = line.indexOf('<!--', index)
      if (open < 0) {
        output += line.slice(index)
        break
      }
      output += line.slice(index, open)
      const close = line.indexOf('-->', open + 4)
      if (close < 0) {
        commentOpen = true
        index = line.length
        break
      }
      index = close + 3
    }
    visible.push(/^(?: {4,}|\t)/.test(output) ? '' : output)
  }

  return { lines: visible, invalid: Boolean(fence || commentOpen) }
}

function parseHeading(line) {
  const match = line.match(/^ {0,3}(#{1,6})(?:[ \t]+(.*))?[ \t]*$/)
  if (!match) return null
  const text = (match[2] ?? '').replace(/[ \t]+#+[ \t]*$/, '').trim()
  return { level: match[1].length, text }
}

function splitRationale(body) {
  const parsed = visibleMarkdownLines(body)
  if (parsed.invalid) return ''

  const headings = parsed.lines.map(parseHeading)
  const rationaleHeading = /^split rationale(?:[ \t]*:[ \t]*(.*)|[ \t]+(.*))?$/i
  const start = headings.findIndex(heading => heading && rationaleHeading.test(heading.text))
  if (start < 0) return ''

  const match = headings[start].text.match(rationaleHeading)
  const nextHeading = headings.findIndex((heading, index) => index > start && heading)
  const section = parsed.lines.slice(start + 1, nextHeading < 0 ? parsed.lines.length : nextHeading)
  const inline = (match?.[1] ?? match?.[2] ?? '').trim()
  if (inline) section.unshift(inline)

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
