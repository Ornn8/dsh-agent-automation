# DSH Agent Automation

This repository connects native GitHub events to two independent local agents without polling:

1. Adding the exact `agent/dsh` label to a trusted Issue starts a fresh DeepSeek Harness headless session. DSH reads its existing provider and credential configuration, then owns the claim, implementation, tests, commit, push, and pull request.
2. Opening or updating a same-repository pull request starts a persisted Codex task with `gpt-5.6-sol` at medium reasoning. Codex reviews a fixed base/head pair without executing pull request code. A blocking verdict returns English findings to GitHub and wakes a fresh DSH repair session; a passing verdict enables squash auto-merge at the reviewed head.

The self-hosted GitHub runner is an idle event listener. It makes no model calls until GitHub assigns a matching job. GitHub Actions logs are the operational source of truth. DSH sessions remain in the configured DSH data directory, and automated Codex review tasks are named `[GitHub Review] ...`; only the six newest remain unarchived.

## Target repository footprint

A target repository needs one thin caller workflow under `.github/workflows/`. The controllers, validation, tests, and machine-independent workflow definitions stay here. GitHub Actions cannot subscribe one repository directly to another repository's Issue and pull request events, so the caller is the only required target-side file.

## Local runner configuration

The runner process receives `DSH_AGENT_CONFIG`, pointing to a machine-local JSON document:

```json
{
  "repositories": ["owner/repository"],
  "dshNode": "X:\\path\\to\\node.exe",
  "dshScript": "X:\\path\\to\\@deepseek-ai\\dsh\\lib\\bin.js",
  "dshHome": "X:\\path\\to\\dsh-data",
  "codexNode": "X:\\path\\to\\node.exe",
  "codexScript": "X:\\path\\to\\@openai\\codex\\bin\\codex.js",
  "codexHome": "X:\\path\\to\\codex-data",
  "codexProjectCwd": "X:\\path\\to\\target-checkout",
  "ghExecutable": "gh.exe",
  "gitExecutable": "git.exe"
}
```

The file contains paths and an allowlist, not credentials. DSH resolves its OpenCode Go API key from `dshHome`; GitHub CLI and Codex use their existing host logins.

## Security and failure behavior

- Fork pull requests never reach the local reviewer.
- DSH dispatch rechecks the live Issue state, exact label, author association, and branch declaration before granting full local access.
- Codex receives no GitHub token and runs with a read-only tool sandbox. CI executes separately.
- A review is bound to exact base and head SHAs. Any head movement discards the verdict.
- Missing or malformed agent output fails closed. Controllers never convert infrastructure failure into PASS.
- Each blocked head receives at most one automatic DSH response. A code fix advances the head and triggers a new review; a technical rebuttal may request one same-head rereview. A repeated block at the same head stops for human inspection instead of looping.
- DSH-created GitHub operations use the host GitHub login rather than `GITHUB_TOKEN`, so the resulting pull request emits normal GitHub workflow events.

Run the controller tests with `npm test`.
