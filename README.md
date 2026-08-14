# DSH Agent Automation

This repository connects native GitHub events to two independent local agents without polling:

1. Adding the exact `agent/dsh` label to a trusted Issue starts a fresh DeepSeek Harness headless session. The event-driven backlog dispatcher adds that label to one ready trusted Issue after each default-branch merge, respects explicit `Depends on` and `Blocked by` declarations, and skips trackers and failed work. DSH reads its existing provider and credential configuration, then owns the claim, implementation, tests, commit, push, and pull request. Trusted `[BUG]` Issues without an explicit branch use `agent/issue-<number>`.
2. Opening or updating a same-repository pull request, including a stacked pull request, starts a persisted Codex task with `gpt-5.6-sol` at medium reasoning. Codex reviews the exact base/head pair without executing pull request code. A blocking verdict returns English findings to GitHub and dispatches one idempotent DSH repair request. A completed failed `CI` workflow run dispatches a separate repair request bound to its run attempt and exact PR head. Trusted changes-requested reviews and inline review comments wake DSH directly; conversation comments remain explicit commands beginning with `@dsh fix`, `@dsh repair`, `@dsh rework`, `@dsh revise`, `@dsh address`, or the equivalent `DSH:` form.
3. A passing review does not leave long-lived auto-merge enabled. It requests a deterministic landing attempt. The landing controller reads the live branch protection requirements, requires a recorded PASS for the current exact base/head pair, requires every protected check to pass, rechecks the pair, and only then performs the squash merge. A default-branch push reconciles open non-behind pull requests whose effective base/head pair has not been reviewed.

The self-hosted GitHub runner is an idle event listener. It makes no model calls until GitHub assigns a matching implementation or review job. Reconciliation, landing, and health jobs are deterministic and make no model calls. GitHub Actions logs and exact-SHA comments are the operational source of truth. DSH status comments include the visible session id. Codex reviews run as named ChatGPT Desktop tasks under the configured project directory, retain their live tool timeline, and show a concise Chinese final answer with the machine result in a collapsed section; only the six newest `[GitHub Review] ...` tasks remain unarchived.

## Target repository footprint

A target repository needs only thin caller workflows under `.github/workflows/`. Each caller pins both the reusable workflow and its controller checkout to one audited full commit SHA. Controller upgrades therefore arrive as ordinary reviewed dependency changes instead of changing live behavior through a mutable branch. The controllers, validation, tests, and machine-independent workflow definitions stay here.

## Local runner configuration

The runner process receives `DSH_AGENT_CONFIG`, pointing to a machine-local JSON document:

```json
{
  "repositories": ["owner/repository"],
  "dshWebBaseUrl": "http://127.0.0.1:3080",
  "codexNode": "X:\\path\\to\\node.exe",
  "codexScript": "X:\\path\\to\\@openai\\codex\\bin\\codex.js",
  "codexHome": "X:\\path\\to\\codex-data",
  "codexProjectCwd": "X:\\path\\to\\target-checkout",
  "ghExecutable": "gh.exe",
  "gitExecutable": "git.exe"
}
```

The file contains paths and an allowlist, not credentials. The local DSH Web Host resolves its already-configured OpenCode Go API key. DSH execution and the landing transport use the existing host GitHub login; Codex review publication is forced through the job-scoped GitHub Actions token, while the Codex task itself receives neither token. The Web Host must be running, but an idle Host and self-hosted runner make no model calls. Each DSH job creates a Chinese-titled, UI-owned `workspace-write` session and waits on local session state without scheduled model polling. Control operations use Web Host RPC methods and are never sent as model chat commands.

Run the target workflow's `health` dispatch operation to verify the controller revision, DSH Web Host, Codex binary, and GitHub repository access without making a model call.

## Security and failure behavior

- Fork pull requests never reach the local reviewer.
- DSH dispatch rechecks the live Issue state, exact label, author association, and branch declaration before granting full local access.
- Codex receives no GitHub token and runs with a read-only tool sandbox. CI executes separately.
- A review comment is bound to exact base and head SHAs. Any ref movement during review discards the verdict, and landing independently requires the same pair.
- Review publication uses the GitHub Actions identity rather than the DSH host credential. Configure branch protection to require `codex/review` from that expected App source.
- Missing or malformed agent output fails closed. Controllers never convert infrastructure failure into PASS.
- Each exact blocked review pair receives one idempotent automatic DSH request. A code fix advances the head and triggers a new review; a technical rebuttal may request one same-head rereview. A failed repair remains visibly blocked and requires a distinct trusted recovery request instead of looping.
- CI repair accepts only a completed failed workflow named `CI`, a matching pull request number, and the exact current head. The run id and attempt make repeated workflow events idempotent; the bootstrap head form independently locates the matching failed run before starting DSH.
- Each explicit trusted rework comment has its own immutable comment id, so a new request on the same head is handled once without reopening an older automatic-review loop.
- DSH-created GitHub operations use the host GitHub login rather than `GITHUB_TOKEN`, so the resulting pull request emits normal GitHub workflow events.
- Reusable workflows reject non-SHA controller revisions and pin third-party actions to immutable commits.

Run the controller tests with `npm test`.
