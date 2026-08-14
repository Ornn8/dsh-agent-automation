The invoking user message contains a JSON WorkRequest after `/github-issue-work`. It names `repository`, `issueNumber`, `defaultBranch`, and `branch`. Treat those fields as controller-supplied routing data, then verify the live GitHub state yourself.

Use the current checkout and complete the Issue end to end. Read the live Issue, its comments, repository instructions, and the current diff before editing. Work only on the declared branch. Do not delegate the implementation or wait for another agent.

Keep every GitHub-visible comment, commit, branch, and pull request field in English. Add a `CLAIMED:` Issue comment if no valid claim exists. Implement the complete request, including required tests, documentation, and repository-specific notes. Run checks appropriate to the actual diff. Commit and push the branch, then open or update one pull request to the declared default branch whose body contains `Closes #<issueNumber>`.

Before pushing, re-read the live branch and Issue so stale work cannot overwrite a newer result. If completion is impossible, post one English `BLOCKED:` Issue comment with concrete evidence and do not claim success. Finish the local DSH session with a concise Chinese report only after the pull request exists at the pushed head or the blocked handoff is recorded.
