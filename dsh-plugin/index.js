import { readFileSync } from 'node:fs'

export const name = 'github-work-skills'
export const inject = ['skills']

const skills = [
  ['github-issue-work', 'Implement one trusted GitHub Issue and publish its pull request.', 'issue.md'],
  ['github-pr-repair', 'Repair or rebut one exact GitHub pull request head.', 'repair.md'],
  ['github-pr-review', 'Review one exact pull request base and head without changing it.', 'review.md'],
]

/** Register controller-owned GitHub work as explicit DSH skills. */
export function apply(ctx) {
  for (const [skillName, description, filename] of skills) {
    ctx.skills.register({
      name: skillName,
      description,
      whenToUse: `Only when a trusted controller explicitly sends /${skillName}.`,
      source: 'dsh-agent-automation',
      invocation: { modelInvocable: false, userInvocable: true },
      content: readFileSync(new URL(`./skills/${filename}`, import.meta.url), 'utf8').trim(),
    })
  }
}
