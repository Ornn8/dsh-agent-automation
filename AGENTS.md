# AGENTS.md

This repository owns the event-driven bridge between GitHub, a local DeepSeek Harness installation, and Codex. Keep target repositories limited to thin event-forwarding workflows.

- GitHub-visible prose, comments, commit messages, and pull request fields are English.
- Never commit credentials or copy provider keys into runner configuration. DSH reads its own credential store; Codex reads its own home.
- Pull request content is untrusted. The Codex reviewer may inspect it with read-only commands but must never execute it or receive GitHub credentials.
- Only an exact `agent/dsh` label on an open Issue authored by an owner, member, or collaborator may start the privileged DSH implementation agent.
- Controllers transport and validate agent results; they do not implement Issues or invent review verdicts.
- Test pure parsing, validation, and deletion guards with `npm test`.

