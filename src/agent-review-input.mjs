import path from 'node:path'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'

function reviewPair(taskId) {
  const match = /^review-([0-9a-f]{40})-([0-9a-f]{40})$/.exec(taskId)
  if (!match) throw new Error('Agent review taskId must bind one lowercase full base and head SHA')
  return { base: match[1], head: match[2] }
}

/** Prepare adapter-neutral review material for one controller-verified commit pair. */
export async function prepareAgentReviewInput({
  checkout,
  taskId,
  gitExecutable,
  runCommand,
  environment,
  timeoutMs,
  signal,
  directoryPrefix,
}) {
  const { base, head } = reviewPair(taskId)
  const git = args => runCommand(gitExecutable, ['-C', checkout, ...args], {
    env: environment,
    timeoutMs,
    signal,
  })
  const diff = await git(['diff', '--no-ext-diff', '--no-textconv', '--find-renames', `${base}...${head}`])
  const tree = await git(['ls-tree', '-r', '--name-only', base])
  const guidancePaths = tree.stdout.split(/\r?\n/)
    .filter(candidate => candidate === 'AGENTS.md' || candidate.endsWith('/AGENTS.md'))
  const guidance = {}
  for (const guidancePath of guidancePaths) {
    const value = await git(['show', `${base}:${guidancePath}`])
    guidance[guidancePath] = value.stdout
  }
  const projectDirectory = await mkdtemp(path.join(tmpdir(), directoryPrefix))
  try {
    await writeFile(path.join(projectDirectory, 'review-input.json'), JSON.stringify({
      version: 1,
      base,
      head,
      diff: diff.stdout,
      guidance,
    }, null, 2), 'utf8')
    return { projectDirectory, base, head }
  } catch (error) {
    await rm(projectDirectory, { recursive: true, force: true })
    throw error
  }
}
