import { resolveWorkflow } from './workflow-profile.mjs'

function exactlyOne(items, description) {
  if (items.length !== 1) throw new Error(`GitHub PR cycle requires exactly one ${description} Stage`)
  return items[0]
}

/** Resolve the bundled GitHub PR lifecycle Adapter from generic Stage data. */
export function resolveGithubPrCycle(definition, workflowId) {
  const workflow = resolveWorkflow(definition, workflowId)
  const merge = exactlyOne(workflow.stages.filter(stage => stage.uses === 'merge'), 'merge')
  const checks = exactlyOne(workflow.stages.filter(stage => stage.uses === 'checks'), 'checks')
  const review = exactlyOne(workflow.stages.filter(stage => stage.uses === 'worker'
    && stage.procedure === 'github-pr-review'), 'github-pr-review worker')
  const change = exactlyOne(workflow.stages.filter(stage => stage.uses === 'worker'
    && ['github-issue-work', 'github-pr-repair'].includes(stage.procedure)), 'GitHub change worker')
  if (workflow.stages.length !== 4
    || change.after.length !== 0
    || review.after.length !== 1 || review.after[0] !== change.id
    || checks.after.length !== 1 || checks.after[0] !== review.id
    || merge.after.length !== 1 || merge.after[0] !== checks.id) {
    throw new Error('GitHub PR cycle Stages must form change -> review -> checks -> merge')
  }
  return { workflow, change, review, checks, merge }
}
