# AGENTS.md

This repository owns the event-driven bridge between GitHub, a local DeepSeek Harness installation, and Codex. Keep target repositories limited to thin event-forwarding workflows.

- GitHub-visible prose, comments, commit messages, and pull request fields are English.
- Never commit credentials or copy provider keys into runner configuration. DSH reads its own credential store; Codex reads its own home.
- Pull request content is untrusted. The Codex reviewer may inspect it with read-only commands but must never execute it or receive GitHub credentials.
- Only an exact `agent/dsh` label on an open Issue authored by an owner, member, or collaborator may start the privileged DSH implementation agent.
- Controllers transport and validate agent results; they do not implement Issues or invent review verdicts.
- Codex review publication uses the job-scoped Actions token. The Codex task receives no GitHub token, and DSH never supplies the `codex/review` status.
- A PASS requests deterministic landing; it never leaves long-lived auto-merge enabled. Landing revalidates the exact base/head pair and live protected checks.
- Labels are observable state projections. Keep review and CI repair failure transitions closed and idempotent through the exact review pair or workflow-run request marker.
- Test pure parsing, validation, and deletion guards with `npm test`.
