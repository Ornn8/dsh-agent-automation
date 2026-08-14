# dsh-github-work

An out-of-tree DeepSeek Harness bundle for the change-worker side of the GitHub control plane. It registers two model-hidden, user-explicit runtime Skills:

- `/github-issue-work <json>` implements one validated Issue and publishes its pull request.
- `/github-pr-repair <json>` repairs or rebuts one exact pull request head.

The controller validates GitHub authorization and immutable revision identity before opening a visible DSH Web session. It then sends only the named Skill gesture and its JSON WorkRequest. The Web Host injects the Skill body at the first pre-step boundary, so every DSH tool, session event, and UI projection stays on the ordinary plugin path.

Each Skill owns its concise Chinese completion report and final hidden `dsh-automation-result` JSON receipt; the controller prompt contains only the Skill invocation and WorkRequest. Only a proven required-check baseline failure creates or reuses a same-repository Issue: it uses a deterministic `dsh-ci-baseline:v1` body marker and matching English title, adds `agent/dsh`, and returns `{"version":1,"outcome":"blocked","blockedReason":"ci-baseline",...}` with that Issue's number and URL. A pull request that already implements that Issue returns `cannot-complete` without an Issue; a non-CI external blocker returns `external` without an Issue. It does not leave a no-op pull request repair. The receipt is a machine-readable report, not an authorization grant. The controller independently validates all live GitHub state, and GitHub comments remain audit records rather than a routing or authorization channel. Completed, `cannot-complete`, and `external` receipts do not contain an Issue.

Install through the controller's Windows installer. For an isolated manual profile test:

```powershell
dsh plugin --profile web add F:\path\to\dsh-agent-automation\dsh-plugin
dsh --profile web --dump-config
```

The bundle contains no GitHub or model credential and makes no network request by itself. Removing or stopping the controller runners leaves these dormant explicit Skills installed; no model call occurs until a trusted controller submits one of the two gestures.
