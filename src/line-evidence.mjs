/** Return a repository line or fail when the reference is outside the file. */
export function referencedLine(content, line, reference) {
  const lines = String(content).split(/\r?\n/)
  if (line < 1 || line > lines.length) throw new Error(`Evidence line is outside ${reference}`)
  return lines[line - 1]
}

/** Verify that an exact file line contains the supplied evidence excerpt. */
export function assertLineExcerpt({ content, line, excerpt, reference }) {
  if (!referencedLine(content, line, reference).includes(excerpt)) {
    throw new Error(`Evidence excerpt does not match line ${line} of ${reference}`)
  }
}

/** Return the text added at one new-file line in a unified-zero patch. */
export function addedPatchLine(patch, line) {
  let newLine
  for (const text of String(patch || '').split(/\r?\n/)) {
    const hunk = text.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/)
    if (hunk) {
      newLine = Number.parseInt(hunk[1], 10)
      continue
    }
    if (newLine === undefined || text.startsWith('\\')) continue
    if (text.startsWith('+') && !text.startsWith('+++')) {
      if (newLine === line) return text.slice(1)
      newLine += 1
      continue
    }
    if (text.startsWith('-') && !text.startsWith('---')) continue
    if (text.startsWith(' ')) newLine += 1
  }
  return undefined
}

/** Verify that a file-line excerpt is also an added line in the exact diff. */
export function assertChangedLineExcerpt({ content, patch, line, excerpt, reference }) {
  assertLineExcerpt({ content, line, excerpt, reference })
  const changedLine = addedPatchLine(patch, line)
  if (changedLine === undefined || !changedLine.includes(excerpt)) {
    throw new Error(`Evidence excerpt does not match a changed line ${line} of ${reference}`)
  }
}
