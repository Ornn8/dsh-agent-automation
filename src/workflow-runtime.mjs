import { resolveWorkflow, resolveWorkflowStage } from './workflow-profile.mjs'

function completedSet(value) {
  if (!Array.isArray(value) || value.some(id => typeof id !== 'string')) {
    throw new Error('Completed Stages must be an array of Stage ids')
  }
  return new Set(value)
}

/** Rebuild the currently eligible Stages from trusted completed-Stage evidence. */
export function eligibleWorkflowStages(definition, workflowId, completedStageIds) {
  const workflow = resolveWorkflow(definition, workflowId)
  const completed = completedSet(completedStageIds)
  const known = new Set(workflow.stages.map(stage => stage.id))
  for (const id of completed) {
    if (!known.has(id)) throw new Error(`Completed evidence names unknown Stage ${id}`)
  }
  return workflow.stages.filter(stage => !completed.has(stage.id)
    && stage.after.every(dependency => completed.has(dependency)))
}

/** Reject an execution attempt whose declared predecessors are not complete. */
export function requireEligibleWorkflowStage(definition, workflowId, stageId, completedStageIds) {
  const stage = resolveWorkflowStage(definition, workflowId, stageId)
  const eligible = eligibleWorkflowStages(definition, workflowId, completedStageIds)
  if (!eligible.some(candidate => candidate.id === stage.id)) {
    throw new Error(`Workflow ${workflowId} Stage ${stage.id} is not eligible`)
  }
  return stage
}
