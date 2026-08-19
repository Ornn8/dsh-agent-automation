import { actionsCredentialEnvironment, requiredEnv, run } from './common.mjs'

const repository = requiredEnv('TARGET_REPOSITORY')
const pullRequestNumber = Number.parseInt(requiredEnv('PR_NUMBER'), 10)
const base = requiredEnv('BASE_SHA').toLowerCase()
const head = requiredEnv('HEAD_SHA').toLowerCase()
const profileId = process.env.PROFILE_ID?.trim() || 'github-pr-cycle'
const workflowId = process.env.WORKFLOW_ID?.trim() || 'default'
const githubExecutable = process.env.GH_EXECUTABLE?.trim() || 'gh'

if (!Number.isSafeInteger(pullRequestNumber) || pullRequestNumber < 1
  || !/^[0-9a-f]{40}$/.test(base) || !/^[0-9a-f]{40}$/.test(head)) {
  throw new Error('Advancement wake requires one exact pull request pair')
}

await run(githubExecutable, [
  'api', '--method', 'POST', `repos/${repository}/dispatches`, '--input', '-',
], {
  env: actionsCredentialEnvironment(),
  input: JSON.stringify({
    event_type: 'dsh-advance',
    client_payload: {
      pull_request_number: pullRequestNumber,
      base_sha: base,
      head_sha: head,
      profile_id: profileId,
      workflow_id: workflowId,
    },
  }),
})
process.stdout.write(`Requested exact-state advancement for pull request #${pullRequestNumber} at ${base}..${head}.\n`)
