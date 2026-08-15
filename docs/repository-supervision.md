# Scheduled repository supervision

Repository supervision is a read-only model audit followed by a fail-closed controller mutation boundary. The model never receives GitHub credentials. It may propose a bounded machine result; the controller validates repository evidence, English-only output, Issue structure, dependency state, duplicate state, active work, label safety, idempotency, and mutation limits before any write.

## Rollout

1. Merge the controller change and record the resulting full commit SHA.
2. Pin every reusable workflow caller in the target repository to that same immutable SHA.
3. Add a target-side caller with a manual dry-run and a schedule.
4. Run the manual dry-run and inspect the Actions summary.
5. Enable scheduled apply mode only after the dry-run produces the expected plan.

A target caller can use this shape:

```yaml
name: Repository Supervision

on:
  schedule:
    - cron: '17 */6 * * *'
  workflow_dispatch:
    inputs:
      apply_changes:
        description: Apply validated repository-management changes.
        required: false
        default: false
        type: boolean

permissions:
  actions: read
  checks: read
  contents: read
  issues: write
  pull-requests: write

jobs:
  supervise:
    uses: Ornn8/dsh-agent-automation/.github/workflows/repository-supervisor.yml@<full-controller-sha>
    with:
      upstream_repository: deepseek-ai/deepseek-harness
      apply_changes: ${{ github.event_name == 'schedule' || inputs.apply_changes }}
      max_mutations: 5
```

The cron minute is intentionally offset from the top of the hour. GitHub schedules run in UTC; `17 */6 * * *` executes at 00:17, 06:17, 12:17, and 18:17 UTC.

## Guardrails

- The target default branch and upstream head are re-read at run time.
- The target checkout must equal the live default-branch head.
- The configured review worker must use the credential-isolated `codex-app` adapter.
- Repository content and GitHub discussion are treated as untrusted data.
- The model cannot execute code or use GitHub CLI.
- At most one Issue and five total GitHub mutations may be proposed per run.
- Unsafe `agent/dsh` labels are removed deterministically even when the model omits the correction.
- Repeated fingerprints do not duplicate Issues or comments.
- Formal pull-request reviews are not available to this workflow.

## Dry run and emergency disablement

Manual dispatch defaults to `apply_changes: false`. In dry-run mode the controller still performs the complete audit and validates the proposal, but writes only the Actions step summary.

To stop scheduled writes immediately, disable the target workflow in GitHub Actions or remove its `schedule` trigger. Removing the caller does not alter the controller or any application code.
