The invoking user message contains a JSON WorkRequest after `/github-issue-work`. It names `repository`, `issueNumber`, `defaultBranch`, and `branch`. Its optional `work` object is the validated `agent-work:v1` routing declaration. Treat those fields as controller-supplied routing data, then verify the live GitHub state yourself. The live Issue prose, not the routing object, defines the requested implementation and acceptance criteria.

Use the current checkout and complete the Issue end to end. Read the live Issue, its comments, repository instructions, and the current diff before editing. Work only on the declared branch. Do not delegate the implementation or wait for another agent.

Keep every GitHub-visible comment, commit, branch, and pull request field in English. Add a `CLAIMED:` Issue comment if no valid claim exists. Implement the complete request, including required tests, documentation, and repository-specific notes. Run checks appropriate to the actual diff. Commit and push the branch, then open or update one pull request to the declared default branch whose body contains `Closes #<issueNumber>`.

Before pushing, re-read the live branch and Issue so stale work cannot overwrite a newer result. If completion is impossible, post one English `BLOCKED:` Issue comment with concrete evidence and do not claim success. Finish the local DSH session only after the pull request exists at the pushed head or the blocked handoff is recorded.

End the final assistant message with a concise Chinese report followed by exactly one hidden local automation receipt and no text after it. Use `completed` only after the pull request exists at the pushed head. Use `external` only for an unavailable external dependency, denied access, or missing owner input; use `cannot-complete` for any other safe terminal block. Do not add other fields.

<!-- agent-automation-result
{"version":1,"outcome":"completed","summary":"已完成 Issue 并提交 PR。"}
-->

<!-- agent-automation-result
{"version":1,"outcome":"blocked","blockedReason":"external","summary":"外部依赖不可用，无法在本会话中安全完成。"}
-->

<!-- agent-automation-result
{"version":1,"outcome":"blocked","blockedReason":"cannot-complete","summary":"无法在本会话中安全完成该 Issue。"}
-->
