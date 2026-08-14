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
3. Register an idle self-hosted runner with a role label such as `agent-change` or `agent-reviewer`.
4. Map the target workflow role to the worker with `worker_id` and `runner_labels_json`.

No controller workflow needs agent-specific branches. For a command-line agent, `command-json` sends the invocation as JSON on stdin and reads the terminal receipt as JSON from stdout.

## Current behavior

1. Adding the exact `agent/dsh` label to a trusted Issue starts the configured change Worker. The backlog dispatcher selects one ready Issue after each default-branch merge and respects explicit dependencies.
2. Opening or updating a same-repository pull request starts the configured review Worker on the review runner. The current Codex Adapter creates a visible ChatGPT Desktop task using `gpt-5.6-sol` at medium reasoning and archives automated review tasks beyond the newest six.
3. A blocking exact-pair review publishes one idempotent change WorkRequest. Failed CI and trusted review feedback use the same change queue through their validated request forms.
4. PASS requests deterministic landing. The landing controller requires the current exact base/head PASS authored by the trusted `github-actions[bot]` review identity and all protected checks, revalidates the pair, and performs the squash merge.

The runners are idle outbound GitHub listeners. They make no model calls while no matching job exists. Landing, reconciliation, dispatch, and health checks are deterministic.

## Local configuration

Set `DSH_AGENT_CONFIG` to a machine-local JSON file based on [config.example.json](config.example.json). The file contains paths and repository allowlists, not provider keys. Each agent continues to use its own existing provider configuration.

Legacy `dshWebBaseUrl` and `codex*` fields are migrated in memory to `workers.dsh` and `workers.codex`, so a controller upgrade does not interrupt existing jobs.

## Runner isolation

Run review and change roles with distinct runner registrations and working directories:

- `[self-hosted, Windows, X64, agent-reviewer]`
- `[self-hosted, Windows, X64, agent-change]`

Stopping the review runner leaves change work operational. Stopping the change runner leaves review work operational and keeps change WorkRequests queued in GitHub. Both still share the host machine, network, and GitHub, which remain common physical failure domains.

## Security and failure behavior

- Fork pull requests never reach local workers.
- Privileged Issue and feedback requests revalidate author association and live repository state.
- Review workers receive no GitHub token and inspect pull request code without executing it.
- Review comments and WorkRequests bind full base and head SHAs. Ref movement makes the result stale.
- Landing authenticates the PASS comment by its `github-actions[bot]` publisher, not its body text, so a pull request author cannot forge an exact pair PASS.
- Missing or malformed worker output never becomes PASS.
- Each exact blocked pair has one idempotency key. A new head creates a new review; a same-head rebuttal creates at most one rereview.
- Reusable workflows reject mutable controller revisions and pin third-party Actions by full commit SHA.

Run controller tests with `npm test`.
