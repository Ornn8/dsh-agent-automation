import { readFile } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { parseJson } from './common.mjs'
import { parseWorkflowDefinition, workflowDefinitionHash } from './workflow-definition.mjs'

export const DEFAULT_PROFILE_ID = 'github-pr-cycle'
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const FULL_SHA = /^[0-9a-f]{40}$/
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/

function requiredId(value, name) {
  if (typeof value !== 'string' || !ID.test(value)) {
    throw new Error(`${name} must be an identifier of at most 64 characters`)
  }
  return value
}

/** Load one controller-owned Profile by its bounded identifier. */
export async function loadWorkflowProfile(profileId = DEFAULT_PROFILE_ID, options = {}) {
  const id = requiredId(profileId, 'Profile id')
  const profilesRoot = options.profilesRoot
    ? resolve(options.profilesRoot)
    : fileURLToPath(new URL('../profiles/', import.meta.url))
  const path = resolve(profilesRoot, id, 'profile.json')
  const readText = options.readText || (target => readFile(target, 'utf8'))
  const definition = parseWorkflowDefinition(parseJson(
    await readText(path),
    `Profile ${id}`,
  ))
  if (definition.profileId !== id) {
    throw new Error(`Profile directory ${id} contains profileId ${definition.profileId}`)
  }
  return {
    definition,
    definitionHash: workflowDefinitionHash(definition),
    source: pathToFileURL(path).href,
  }
}

/** Return the fixed target-repository path for a Profile id. */
export function repositoryProfilePath(profileId = DEFAULT_PROFILE_ID) {
  return `.github/agent-automation/profiles/${requiredId(profileId, 'Profile id')}.json`
}

/** Parse a trusted target-repository Profile and bind it to its exact revision. */
export async function loadTrustedWorkflowProfile({ repository, revision, profileId, loadContent }) {
  if (!REPOSITORY.test(repository || '')) throw new Error('Trusted Profile repository is invalid')
  if (!FULL_SHA.test(revision || '')) throw new Error('Trusted Profile revision must be a full lowercase SHA')
  if (typeof loadContent !== 'function') throw new Error('Trusted Profile loading requires a content reader')
  const id = requiredId(profileId || DEFAULT_PROFILE_ID, 'Profile id')
  const path = repositoryProfilePath(id)
  const source = await loadContent({ repository, revision, path })
  const definition = parseWorkflowDefinition(parseJson(source, `Profile ${id} at ${revision}`))
  if (definition.profileId !== id) {
    throw new Error(`Profile path ${path} contains profileId ${definition.profileId}`)
  }
  return { definition, definitionHash: workflowDefinitionHash(definition), repository, revision, path }
}

/** Resolve one named workflow from a validated Profile. */
export function resolveWorkflow(definition, workflowId) {
  const id = requiredId(workflowId, 'Workflow id')
  const parsed = parseWorkflowDefinition(definition)
  const workflow = parsed.workflows[id]
  if (!workflow) throw new Error(`Profile ${parsed.profileId} does not define workflow ${id}`)
  return workflow
}

/** Resolve one Stage and optionally require its Adapter kind. */
export function resolveWorkflowStage(definition, workflowId, stageId, expectedUses) {
  const workflow = resolveWorkflow(definition, workflowId)
  const id = requiredId(stageId, 'Stage id')
  const stage = workflow.stages.find(candidate => candidate.id === id)
  if (!stage) throw new Error(`Workflow ${workflowId} does not define Stage ${id}`)
  if (expectedUses !== undefined && stage.uses !== expectedUses) {
    throw new Error(`Workflow ${workflowId} Stage ${id} uses ${stage.uses}, expected ${expectedUses}`)
  }
  return stage
}

/** Return the single root worker Stage supported by Issue dispatch. */
export function resolveIssueEntryStage(definition, workflowId) {
  const workflow = resolveWorkflow(definition, workflowId)
  const entries = workflow.stages.filter(stage => stage.after.length === 0 && stage.uses === 'worker')
  if (entries.length !== 1) {
    throw new Error(`Workflow ${workflowId} must expose exactly one root worker Stage for Issue dispatch`)
  }
  return entries[0]
}
