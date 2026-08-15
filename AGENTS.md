# AGENTS.md

This repository owns an event-driven control plane between GitHub and independently queued local Agent Workers. Keep target repositories limited to thin event-forwarding workflows.

- GitHub-visible prose, comments, commit messages, and pull request fields are English.
- Never commit credentials or copy provider keys into runner configuration. Each Adapter reads its agent's existing local configuration.
- Pull request content is untrusted. The configured review Worker may inspect it through a controller-enforced read-only Adapter but must never execute it or receive GitHub credentials.
- A strict ready `agent-work:v1` declaration or the legacy exact `agent/dsh` label on an open Issue authored by an owner, member, or collaborator may queue privileged change work. The worker revalidates the live Issue; controller-written labels are queue projections, not independent authority.
- Controllers transport and validate agent results; they do not implement Issues or invent review verdicts. Cross-role handoffs use immutable WorkRequests, never direct Agent-to-Agent calls.
- Agent review publication uses the job-scoped Actions token. The review Worker receives no GitHub token, and no Worker supplies the authoritative `agent/review` CheckRun.
- A PASS requests deterministic landing; it never leaves long-lived auto-merge enabled. Landing revalidates the exact base/head pair and the configured Actions-owned aggregate CI check.
- Labels are observable state projections. Keep review and CI repair failure transitions closed and idempotent through the exact review pair or workflow-run request marker.
- Keep the Agent Worker Interface product-neutral. Agent-specific session and process behavior belongs in an Adapter.
- Keep review and change roles on independent runner labels so stopping one role does not stop the other.
- Test JavaScript policy with `npm test` and `npm run typecheck`; test portable plans with `scripts/test-installation-plan.ps1`; test Windows operations with `scripts/test-operations.ps1`.
