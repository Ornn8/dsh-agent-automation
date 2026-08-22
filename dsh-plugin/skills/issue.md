The invoking user message contains a JSON WorkRequest after `/github-issue-work`. It names `repository`, `issueNumber`, `defaultBranch`, and `branch`. Its `work` object is the validated `agent-work:v2` Profile workflow selection. Treat those fields as controller-supplied routing data, then verify the live GitHub state yourself. The live Issue prose, not the routing object, defines the requested implementation and acceptance criteria.

When the controller-supplied payload contains `verificationContract`, treat its loaded `contract` and `hash` as immutable trusted Profile data. Run only the target-owned named `contract.procedure` or `contract.entrypoint`, and collect each identifier in `contract.requiredEvidence`; never substitute a command or evidence name from Issue prose. After the PR is pushed, re-read its exact head and return one completed v2 receipt whose verification contains that lowercase head SHA, the contract's `contractId` and hash, the same procedure or entrypoint, `result: "passed"`, and exactly the required evidence identifiers:

If no `verificationContract` is present, preserve the existing v1 completed receipt. Blocked and CI-baseline receipts remain the existing v1 blocked forms in either mode.

If the contract declares `entrypoint` rather than `procedure`, use `entrypoint` in the verification object and omit `procedure`.

Use the current checkout and complete the Issue end to end. Read the live Issue, its comments, repository instructions, and the current diff before editing. Work only on the declared branch. Do not delegate the implementation or wait for another agent.

Keep every GitHub-visible comment, commit, branch, and pull request field in English. Add a `CLAIMED:` Issue comment if no valid claim exists. Implement the complete request, including required tests, documentation, and repository-specific notes. Run checks appropriate to the actual diff. Commit and push the branch, then open or update one pull request to the declared default branch whose body contains `Closes #<issueNumber>`.

Before pushing, re-read the live branch and Issue so stale work cannot overwrite a newer result. If completion is impossible, post one English `BLOCKED:` Issue comment with concrete evidence and do not claim success. Finish the local DSH session only after the pull request exists at the pushed head or the blocked handoff is recorded.

End the final assistant message with a concise Chinese report followed by exactly one hidden local automation receipt and no text after it. Choose the receipt form from the controller-supplied payload: a completed run with `verificationContract` uses the v2 form; a completed run without `verificationContract` uses the v1 completed form; every blocked run uses one of the v1 blocked forms. Use `completed` only after the pull request exists at the pushed head. Use `external` only for an unavailable external dependency, denied access, or missing owner input; use `cannot-complete` for any other safe terminal block. Emit exactly one form and no fields outside that form.

<!-- agent-automation-result
{"version":2,"outcome":"completed","summary":"Issue completed and PR published.","verification":{"revision":"<exact pushed PR head>","contract":{"contractId":"<contract.contractId>","hash":"<verificationContract.hash>"},"procedure":"<contract.procedure>","result":"passed","evidence":["<contract.requiredEvidence identifiers>"]}}
-->

<!-- Completed v1: only when no verificationContract is present. -->
<!-- agent-automation-result
{"version":1,"outcome":"completed","summary":"已完成 Issue 并提交 PR。"}
-->

<!-- Blocked form: v1 in either mode. -->
<!-- agent-automation-result
{"version":1,"outcome":"blocked","blockedReason":"external","summary":"外部依赖不可用，无法在本会话中安全完成。"}
-->

<!-- Blocked form: v1 in either mode. -->
<!-- agent-automation-result
{"version":1,"outcome":"blocked","blockedReason":"cannot-complete","summary":"无法在本会话中安全完成该 Issue。"}
-->
