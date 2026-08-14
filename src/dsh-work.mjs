export const DSH_ISSUE_SKILL = 'github-issue-work'
export const DSH_REPAIR_SKILL = 'github-pr-repair'

/** Render one structured WorkRequest as a user-explicit DSH skill invocation. */
export function dshWorkPrompt(skillName, workRequest) {
  if (![DSH_ISSUE_SKILL, DSH_REPAIR_SKILL].includes(skillName)) {
    throw new Error(`Unknown DSH work skill: ${skillName}`)
  }
  if (!workRequest || typeof workRequest !== 'object' || Array.isArray(workRequest)) {
    throw new Error('DSH WorkRequest must be an object')
  }
  return `/${skillName} ${JSON.stringify(workRequest)}`
}
