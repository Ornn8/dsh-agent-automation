# AGENTS.md

This repository owns an event-driven control plane between GitHub and independently queued local Agent Workers. Keep target repositories limited to thin event-forwarding workflows.

- GitHub-visible prose, comments, commit messages, and pull request fields are English.
- Never commit credentials or copy provider keys into runner configuration. Each Adapter reads its agent's existing local configuration.
- Pull request content is untrusted. The Codex reviewer may inspect it with read-only commands but must never execute it or receive GitHub credentials.
- A strict ready `agent-work:v1` declaration or the legacy exact `agent/dsh` label on an open Issue authored by an owner, member, or collaborator may queue privileged change work. The worker revalidates the live Issue; controller-written labels are queue projections, not independent authority.
- Controllers transport and validate agent results; they do not implement Issues or invent review verdicts. Cross-role handoffs use immutable WorkRequests, never direct Agent-to-Agent calls.
- Codex review publication uses the job-scoped Actions token. The Codex task receives no GitHub token, and DSH never supplies the `codex/review` status.
- A PASS requests deterministic landing; it never leaves long-lived auto-merge enabled. Landing revalidates the exact base/head pair and the configured Actions-owned aggregate CI check.
- Labels are observable state projections. Keep review and CI repair failure transitions closed and idempotent through the exact review pair or workflow-run request marker.
- Keep the Agent Worker Interface product-neutral. Agent-specific session and process behavior belongs in an Adapter.
- Keep review and change roles on independent runner labels so stopping one role does not stop the other.
- Test pure parsing, validation, and deletion guards with `npm test`.
