import { parseAgentWork } from './agent-work.mjs'

const MAX_DIAGNOSTICS = 64

function issueNumber(value) {
  return Number.isSafeInteger(value?.number) && value.number > 0 ? value.number : null
}

function fingerprint(issue) {
  let declaration
  try {
    declaration = parseAgentWork(issue.body)
  } catch {
    declaration = 'invalid'
  }
  return JSON.stringify([issue.state, Boolean(issue.pull_request), declaration])
}

function diagnostic(issue, code, dependencyNumber = undefined) {
  return {
    issueNumber: issue,
    code,
    ...(dependencyNumber === undefined ? {} : { dependencyNumber }),
  }
}

/** Build one bounded dependency result from the dispatcher Issue snapshot. */
export function buildIssueDependencyGraph({ issues = [], pullRequests = [] } = {}) {
  const subjects = new Map()
  const conflicts = new Set()
  const diagnostics = new Map()

  for (const subject of Array.isArray(issues) ? issues : []) {
    const number = issueNumber(subject)
    if (number === null || subject.pull_request) continue
    const prior = subjects.get(number)
    if (!prior) {
      subjects.set(number, { issue: subject, fingerprint: fingerprint(subject) })
    } else if (prior.fingerprint !== fingerprint(subject)) {
      conflicts.add(number)
    }
  }

  for (const number of [...conflicts].sort((left, right) => left - right)) {
    diagnostics.set(number, diagnostic(number, 'dependency-conflicting-snapshot'))
  }

  const pullRequestNumbers = new Set(
    (Array.isArray(pullRequests) ? pullRequests : [])
      .map(issueNumber)
      .filter(number => number !== null),
  )
  const states = new Map()
  const openEdges = new Map()

  for (const number of [...subjects.keys()].sort((left, right) => left - right)) {
    if (conflicts.has(number)) continue
    const issue = subjects.get(number).issue
    let work
    try {
      work = parseAgentWork(issue.body)
    } catch {
      diagnostics.set(number, diagnostic(number, 'dependency-invalid-declaration'))
      continue
    }
    if (!work) continue

    const openDependencies = []
    let invalid
    for (const dependencyNumber of [...work.dependsOn].sort((left, right) => left - right)) {
      if (dependencyNumber === number) {
        invalid = diagnostic(number, 'dependency-self', dependencyNumber)
        break
      }
      if (pullRequestNumbers.has(dependencyNumber)) {
        invalid = diagnostic(number, 'dependency-pull-request', dependencyNumber)
        break
      }
      const dependency = subjects.get(dependencyNumber)?.issue
      if (!dependency) {
        invalid = diagnostic(number, 'dependency-missing', dependencyNumber)
        break
      }
      if (!['open', 'closed'].includes(dependency.state)) {
        invalid = diagnostic(number, 'dependency-invalid-state', dependencyNumber)
        break
      }
      if (dependency.state === 'open') openDependencies.push(dependencyNumber)
    }
    if (invalid) {
      diagnostics.set(number, invalid)
      continue
    }
    states.set(number, { valid: true, openDependencies })
    if (issue.state === 'open') openEdges.set(number, openDependencies)
  }

  const visiting = new Set()
  const visited = new Set()
  const stack = []
  const markCycles = number => {
    const start = stack.indexOf(number)
    for (const cycleNumber of stack.slice(start)) {
      if (!diagnostics.has(cycleNumber)) {
        diagnostics.set(cycleNumber, diagnostic(cycleNumber, 'dependency-cycle'))
        states.delete(cycleNumber)
      }
    }
  }
  const visit = number => {
    if (visiting.has(number)) {
      markCycles(number)
      return
    }
    if (visited.has(number)) return
    visiting.add(number)
    stack.push(number)
    for (const dependencyNumber of openEdges.get(number) || []) visit(dependencyNumber)
    stack.pop()
    visiting.delete(number)
    visited.add(number)
  }
  for (const number of [...openEdges.keys()].sort((left, right) => left - right)) visit(number)

  let propagated = true
  while (propagated) {
    propagated = false
    for (const [number, state] of [...states.entries()].sort(([left], [right]) => left - right)) {
      const dependencyNumber = state.openDependencies.find(dependency => diagnostics.has(dependency))
      if (dependencyNumber === undefined) continue
      diagnostics.set(number, diagnostic(number, 'dependency-invalid', dependencyNumber))
      states.delete(number)
      propagated = true
    }
  }

  const orderedDiagnostics = [...diagnostics.values()]
    .sort((left, right) => left.issueNumber - right.issueNumber || left.code.localeCompare(right.code))
    .slice(0, MAX_DIAGNOSTICS)
  return { states, diagnostics: orderedDiagnostics, rejections: diagnostics }
}

/** Return the dependency result for one Issue number. */
export function issueDependencyState(graph, issueNumberValue) {
  const diagnostic = graph?.rejections?.get(issueNumberValue)
    || graph?.diagnostics?.find(item => item.issueNumber === issueNumberValue)
  if (diagnostic) return { valid: false, diagnostic }
  return graph?.states?.get(issueNumberValue) || { valid: true, openDependencies: [] }
}
