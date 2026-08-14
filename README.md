# Agent Automation Control Plane

This repository connects GitHub events to independently queued local agent workers without model polling. It is not tied to DeepSeek Harness or Codex: those are two current Worker implementations behind the same interface.

## Architecture

GitHub is the durable control plane. A target repository contains only thin event-forwarding workflows pinned to one audited controller commit. Reusable controller workflows validate the event and exact repository revision, select a role, and invoke a configured Worker through an Adapter.

The two current roles are independent:

- `change` handles Issue implementation, review repair, CI repair, and trusted rework requests.
- `review` statically reviews one exact pull request base/head pair and returns PASS or BLOCK.

A BLOCK ends the review job. The controller then publishes an immutable `agent_work_requested` WorkRequest for the `change` role. A separate runner queue consumes it. The reviewer never calls the change agent directly, and neither queue waits for the other process to become idle.

The public Worker invocation is:

```json
{
  "taskId": "stable-idempotency-key",
  "cwd": "X:\\isolated-checkout",
  "title": "visible local task title",
  "prompt": "role-specific instructions",
  "timeoutMs": 10800000
}
```

Every Adapter returns one terminal receipt:

```json
{
  "sessionId": "visible-or-external-session-id",
  "outcome": "completed|blocked|superseded|timed-out|failed",
  "detail": "short machine-readable detail",
  "output": "optional role result"
}
```

Unknown workers, adapters, outcomes, or malformed results fail closed. See [the architecture document](docs/architecture.md) for Module and termination boundaries.

## Adding or replacing an agent

An agent does not need its own GitHub account. GitHub event publication and validation use one controller identity on the host; job-scoped publication uses the Actions identity. Model workers receive no Actions token.

To add an agent:

1. Add a named entry under `workers` in the machine-local configuration.
2. Use an existing Adapter (`dsh-web`, `codex-app`, or `command-json`) or add one Adapter that implements run and health.
3. Configure the role-owned worker id (`dsh` for change or `codex` for review) to use that Adapter.
4. Register an idle self-hosted runner with the controller-owned `agent-change` or `agent-reviewer` label.

No controller workflow needs agent-specific branches. For a command-line agent, `command-json` sends the invocation as JSON on stdin and reads the terminal receipt as JSON from stdout.

## Current behavior

1. Adding the exact `agent/dsh` label to a trusted Issue starts the configured change Worker. The backlog dispatcher selects one ready Issue after each default-branch merge and respects explicit dependencies.
2. Opening or updating a same-repository pull request starts the configured review Worker on the review runner. The current Codex Adapter creates a visible ChatGPT Desktop task using `gpt-5.6-sol` at medium reasoning and archives automated review tasks beyond the newest six.
3. A blocking exact-pair review publishes one idempotent change WorkRequest. Failed CI and explicit trusted rework comments use the same change queue through their validated request forms.
4. A default-branch advance first updates behind same-repository pull requests through GitHub's guarded update-branch API. The resulting head requests a fresh review. PASS then requests deterministic landing: the landing controller requires a successful GitHub Actions CheckRun whose run and `referenced_workflows` provenance bind the current exact base/head pair to the pinned controller revision, plus every protected check; it revalidates and squash-merges.

The runners are idle outbound GitHub listeners. They make no model calls while no matching job exists. Landing, reconciliation, dispatch, and health checks are deterministic.

## Local configuration

Set `DSH_AGENT_CONFIG` to a machine-local JSON file based on [config.example.json](config.example.json). The file contains paths and repository allowlists, not provider keys. Every `dsh-web` worker must declare `provider`, `model`, and `reasoningEffort`; the controller calls `session.selectModel` with that complete selection after creating each session and before prompting it. The example pins DSH work to `opencode-go`, `deepseek-v4-flash`, and `max`. Each agent continues to use its own existing provider configuration.

Configuration schema version 2 accepts only explicit `workers` and `repositoryMappings`; legacy `dshWebBaseUrl` and `codex*` fields are rejected. Existing installations must add the required `github.login`, `workers`, and `operations` fields before using the open-source installer.

## Quick start on Windows

The complete deployment, upgrade, fault-injection, and removal procedure is in the [Windows operations guide](docs/operations.md). Start from an audited controller commit and a machine-local configuration outside the checkout:

```powershell
$controller = 'D:\src\dsh-agent-automation'
$target = 'D:\src\target-repository'
$config = 'F:\dsh-agent-automation-state\agent-config.json'

Copy-Item "$controller\config.example.json" $config
pwsh -NoProfile -File "$controller\scripts\bootstrap-repository.ps1" `
  -TargetCheckout $target `
  -ControllerRepository owner/dsh-agent-automation `
  -ControllerSha 0123456789abcdef0123456789abcdef01234567 `
  -CiWorkflowName 'CI' `
  -DryRun
pwsh -NoProfile -File "$controller\scripts\test-operations.ps1"
pwsh -NoProfile -File "$controller\scripts\test-bootstrap-repository.ps1"
pwsh -NoProfile -File "$controller\scripts\doctor.ps1" -Configuration $config -DryRun
pwsh -NoProfile -File "$controller\scripts\install.ps1" -Configuration $config -DryRun
```

`ControllerSha` must be a published lowercase 40-character SHA that remains permanently reachable from the controller default branch. If a controller PR is squash- or rebase-merged, first verify that the published commit tree exactly matches the reviewed PR-head tree, then pin the published commit; never pin a PR head from a branch that may be deleted. The offline bootstrap renderer does not verify GitHub reachability.

Review the rendered workflows and dry-run output before removing `-DryRun`. The actual installer validates the active GitHub identity, runner archive checksum, immutable operations snapshot, repository variable, and branch protection before it starts either worker. It stores no model or GitHub credential in this repository.

## Runner isolation

Run review and change roles with distinct runner registrations and working directories:

- `[self-hosted, Windows, X64, agent-reviewer]`
- `[self-hosted, Windows, X64, agent-change]`

Stopping the review runner leaves change work operational. Stopping the change runner leaves review work operational and keeps change WorkRequests queued in GitHub. Both still share the host machine, network, and GitHub, which remain common physical failure domains.

## Security and failure behavior

- Fork pull requests never reach local workers.
- Privileged Issue and explicit rework requests revalidate author association and live repository state.
- Review workers receive no GitHub token and inspect pull request code without executing it.
- Review turns start in a controller-created neutral directory. Repository guidance is read only from the verified base revision, so a pull request cannot install reviewer instructions through its head checkout.
- Review comments and WorkRequests bind full base and head SHAs. Ref movement makes the result stale.
- Comments, labels, and compatibility commit statuses are diagnostic projections only. Landing trusts the exact GitHub Actions CheckRun, workflow run, and immutable reusable-workflow provenance, so forged text cannot become PASS.
- Missing or malformed worker output never becomes PASS.
- Each exact blocked pair has one idempotency key. A new head creates a new review; a same-head rebuttal creates at most one rereview.
- Reusable workflows reject mutable controller revisions and pin third-party Actions by full commit SHA.
- Landing requires protected checks to be app-bound and strict, so a base advance invalidates the reviewed pair before GitHub accepts the merge.

Run controller tests with `npm test`. On Windows, also run `scripts/test-operations.ps1` and `scripts/test-bootstrap-repository.ps1`. See [CONTRIBUTING.md](CONTRIBUTING.md) for change requirements and [SECURITY.md](SECURITY.md) for private vulnerability reporting.
