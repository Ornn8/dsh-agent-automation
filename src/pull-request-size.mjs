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
export function evaluatePullRequestSize({ files, changedLines }) {
  files = count(files, 'files')
  changedLines = count(changedLines, 'changedLines')
  const measured = `${unit(files, 'file', 'files')} and ${unit(changedLines, 'changed line', 'changed lines')}`
  if (files > MAX_PULL_REQUEST_FILES) {
    return {
      accepted: false,
      message: `Pull request size exceeds the ${MAX_PULL_REQUEST_FILES}-file limit: ${measured}. Split the change into independently reviewable pull requests.`,
    }
  }
  if (changedLines > MAX_PULL_REQUEST_CHANGED_LINES) {
    return {
      accepted: false,
      message: `Pull request size exceeds the ${MAX_PULL_REQUEST_CHANGED_LINES}-line limit: ${measured}. Split the change into independently reviewable pull requests.`,
    }
  }
  return { accepted: true, message: `Pull request size is reviewable: ${measured}.` }
}
