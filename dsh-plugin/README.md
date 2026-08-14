# dsh-github-work

An out-of-tree DeepSeek Harness bundle for the change-worker side of the GitHub control plane. It registers two model-hidden, user-explicit runtime Skills:

- `/github-issue-work <json>` implements one validated Issue and publishes its pull request.
- `/github-pr-repair <json>` repairs or rebuts one exact pull request head.

The controller validates GitHub authorization and immutable revision identity before opening a visible DSH Web session. It then sends only the named Skill gesture and its JSON WorkRequest. The Web Host injects the Skill body at the first pre-step boundary, so every DSH tool, session event, and UI projection stays on the ordinary plugin path.

Install through the controller's Windows installer. For an isolated manual profile test:

```powershell
dsh plugin --profile web add F:\path\to\dsh-agent-automation\dsh-plugin
dsh --profile web --dump-config
```

The bundle contains no GitHub or model credential and makes no network request by itself. Removing or stopping the controller runners leaves these dormant explicit Skills installed; no model call occurs until a trusted controller submits one of the two gestures.
