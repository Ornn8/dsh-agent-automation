import { Lexer } from 'marked'

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

function commentDelimitersAreBalanced(value) {
  const openings = value.match(/<!--/g)?.length ?? 0
  const closings = value.match(/-->/g)?.length ?? 0
  return openings === closings
}

function inlineText(tokens) {
  let text = ''
  for (const token of tokens ?? []) {
    if (token.type === 'html' || token.type === 'image') continue
    if (Array.isArray(token.tokens)) {
      text += inlineText(token.tokens)
    } else if (typeof token.text === 'string') {
      text += token.text
    }
  }
  return text
}

function tokenChildren(token) {
  const children = []
  if (Array.isArray(token.tokens)) children.push(...token.tokens)
  if (Array.isArray(token.items)) children.push(...token.items)
  if (Array.isArray(token.header)) children.push(...token.header)
  if (Array.isArray(token.rows)) children.push(...token.rows.flat())
  return children
}

function fencedCodeIsClosed(token) {
  const opening = String(token.raw ?? '').match(/^ {0,3}(`{3,}|~{3,})[^\r\n]*(?:\r?\n|$)/)
  if (!opening) return true
  const marker = opening[1][0]
  const closing = new RegExp(`^ {0,3}${marker}{${opening[1].length},}[ \\t]*$`, 'm')
  return closing.test(String(token.raw).slice(opening[0].length))
}

function markdownEvents(body) {
  const events = []
  let invalid = false

  function visit(tokens) {
    for (const token of tokens ?? []) {
      if (token.type === 'html') {
        if (!commentDelimitersAreBalanced(token.raw ?? '')) invalid = true
        continue
      }
      if (token.type === 'heading') {
        events.push({ type: 'heading', level: token.depth, text: inlineText(token.tokens) })
        continue
      }
      if (token.type === 'code') {
        if (!fencedCodeIsClosed(token)) invalid = true
        continue
      }
      if (token.type === 'image') continue

      const children = tokenChildren(token)
      if (children.length) {
        visit(children)
      } else if (typeof token.text === 'string' && (token.type === 'text' || token.type === 'codespan' || token.type === 'paragraph')) {
        events.push({ type: 'text', text: token.text })
      }
    }
  }

  try {
    visit(Lexer.lex(String(body ?? ''), { gfm: true }))
  } catch {
    invalid = true
  }
  return { events, invalid }
}

function splitRationale(body) {
  const parsed = markdownEvents(body)
  if (parsed.invalid) return ''

  const start = parsed.events.findIndex(event => event.type === 'heading' && event.level === 2 && event.text.replace(/\s+/g, ' ').trim().toLowerCase() === 'split rationale')
  if (start < 0) return ''

  const section = []
  for (const event of parsed.events.slice(start + 1)) {
    if (event.type === 'heading' && event.level <= 2) break
    if (event.type === 'text') section.push(event.text)
  }
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
