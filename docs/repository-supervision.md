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
  contents: write
  issues: write
  pull-requests: write

jobs:
  supervise:
    uses: Ornn8/dsh-agent-automation/.github/workflows/repository-supervisor.yml@<full-controller-sha>
    with:
      upstream_repository: upstream-owner/upstream-repository
      apply_changes: ${{ github.event_name == 'schedule' || inputs.apply_changes }}
      max_mutations: 5
```

The cron minute is intentionally offset from the top of the hour. GitHub schedules run in UTC; `17 */6 * * *` executes at 00:17, 06:17, 12:17, and 18:17 UTC.

## Guardrails

- The target default branch and upstream head are re-read at run time.
- Default-branch, pull-request, and upstream file evidence includes an exact line excerpt that the controller rereads; pull-request and upstream evidence must identify a line added or modified by the referenced change, and upstream evidence must name a commit that is reachable from the audited upstream head but absent from the target branch.
- The target checkout must equal the live default-branch head.
- The configured review Adapter must isolate credentials and provide read-only access for `github-repository-supervision`; unsupported Skills fail before any GitHub write.
- Repository content and GitHub discussion are treated as untrusted data.
- The model cannot execute code or use GitHub CLI.
- At most one Issue and five total GitHub mutations may be proposed per run.
- Assigning `agent/dsh` to an Issue dispatches the deterministic `dsh-issue` event, so the caller and this reusable workflow both grant `contents: write`; a reusable workflow can only downgrade caller token permissions, never elevate them.
- Repeated fingerprints do not duplicate Issues or comments.
- Every Issue or pull request target is reread immediately before its mutation; changed state stops the remaining plan.
- Lists are read through at most three 100-item pages; a still-full final page stops the audit instead of accepting an incomplete snapshot.
- Formal pull-request reviews are not available to this workflow.

## Dry run and emergency disablement

Manual dispatch defaults to `apply_changes: false`. In dry-run mode the controller still performs the complete audit and validates the proposal, but writes only the Actions step summary.

To stop scheduled writes immediately, disable the target workflow in GitHub Actions or remove its `schedule` trigger. Removing the caller does not alter the controller or any application code.
