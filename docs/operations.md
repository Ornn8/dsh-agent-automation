# Windows operations

This guide installs the local change and review workers. Controller jobs run on GitHub-hosted runners; there is no local controller runner, task, label, or work directory.

## Runner topology

Two registration modes are supported:

| `registrationScope` | Local instances | Intended account topology |
| --- | --- | --- |
| `target-repositories` | One `change` and one `review` runner for every `repositoryMapping` | Personal accounts and repositories that cannot share an organization runner. This is the example configuration. |
| `organization` | One shared `change` and one shared `review` runner | Organizations whose runner group grants access to every allowlisted target. |

Target-repository instances have deterministic IDs derived from the full repository name plus a short SHA-256 suffix. Each instance has its own GitHub registration, Scheduled Task, runner root, work directory, supervisor log, and fault marker. Stopping `change` for one repository does not stop its `review` runner or either runner for another repository. Organization runners are intentionally shared across all mapped repositories, so repository-level selection is rejected in that mode.

The optional `dsh-web` task is host-wide. Its hidden supervisor probes the loopback RPC endpoint and restarts only the process it started after repeated failures. Each configured `dsh-web` worker must include a nonempty provider, model, and reasoning effort. The controller applies that complete selection through `session.selectModel` after session creation and before every task prompt; missing configuration or a rejected selection fails the job rather than using a UI default. Supervisor lifecycle and health logs are in `logsRoot`; GitHub runner diagnostics remain in each private runner directory.

## Configuration and paths

Use a dedicated Windows account. Install PowerShell 7 (`pwsh`), Git, GitHub CLI, Node, the DSH Web Host, and the configured review adapter. Model credentials remain in those products' existing local configuration.

Copy [config.example.json](../config.example.json) to a machine-local file inside `stateRoot` on a data volume, for example `F:\dsh-agent-automation-state\agent-config.json`. Installed tasks continue to read that file, so it must not remain in a Git checkout. Configuration schema version 2 requires explicit `workers` and repository mappings; legacy top-level worker fields are rejected. The example is ready for an `Ornn8` personal-account topology and demonstrates repository-level registration; replace executable paths, runner release/version/hash, and target mappings as needed.

Set `github.login` to the exact GitHub CLI login on the host. Install and online doctor call `gh api user` and compare only the login, preventing another cached identity from operating the runners. They do not display the login returned by GitHub or any token.

Every `repositories` entry must have exactly one `repositoryMapping` with existing `changeWorker` and `reviewWorker` IDs plus nonempty `ciWorkflowName` and `ciRequiredCheckName` values. Controller jobs receive only the immutable `change` or `review` role and resolve the worker from this local exact mapping; a missing, duplicate, or unknown mapping fails before an agent starts. The latter is the aggregate check emitted by the target CI workflow, for example `all checks passed`. Install idempotently sets that target's Actions variable `DSH_AUTOMATION_CI_WORKFLOW` to the mapped workflow name. The value is routing configuration, not a secret. Uninstall intentionally retains it so disabling a local runner cannot silently alter repository configuration.

`installRoot`, `stateRoot`, and `logsRoot` must be local absolute non-`C:` paths. The scripts reject `C:`, UNC paths, wildcards, volume roots, overlapping roots, mappings beyond the per-host limit, generated paths outside the managed roots, and an installed configuration outside `stateRoot`. Runtime/state directories are restricted to the installing user and `SYSTEM`. Recursive runtime removal rejects reparse points and operates only on enumerated instance or content-addressed runtime directories.

`stateRoot\install-manifest.json` is the authority for installed runner instances, registrations, exact paths, Scheduled Tasks, DSH Web Host ownership, and the installed operations runtime content hash. It contains no tokens or other credentials. Each supervisor also writes an atomic PID record under `stateRoot\pids`; the record binds the child PID to its exact process start time so PID reuse cannot authorize termination of another process. Keep `stateRoot` when editing mappings, role settings, or registration scope. To move `stateRoot`, first use the old configuration to remove all managed registrations and runtime, then install with the new configuration; a new state root cannot safely discover ownership recorded only in the old one.

Install hashes the operations module and both supervisor scripts, then copies exactly those three files into `installRoot\operations-runtime\<content-hash>`. The directory ACL grants the installing user and `SYSTEM` read/execute access; no configuration, credential, runner worktree, or checkout content is copied into it. Scheduled Tasks invoke only scripts in that manifest-recorded snapshot, so switching, updating, moving, or deleting the source checkout cannot silently change an installed service.

## GitHub bootstrap permissions

Prefer a GitHub App or a fine-grained, short-lived PAT used through GitHub CLI. Do not place App keys, PATs, ephemeral runner tokens, or model keys in JSON, repository variables, workflow inputs, logs, or PowerShell history.

For `target-repositories`, the bootstrap identity needs each mapped repository's self-hosted runner administration permission, Actions Variables write permission, and repository Administration write permission for default-branch protection. For `organization`, it needs organization self-hosted runner administration and a runner group explicitly granted to every allowlisted target, plus Variables and Administration write permission for each target. A fine-grained PAT therefore needs repository Administration read/write in addition to runner and Variables permissions; a GitHub App installation needs the equivalent repository permissions. The installer fails closed when it cannot read or update required-status-check protection.

The installer requests an ephemeral registration token for each exact organization or target-repository instance and passes it only to that runner's `config.cmd`. Review workers receive no GitHub token. Repository variables are written through `gh variable set`; their values contain no credential material.

Repository setup must also provide the thin forwarding workflow pinned to an immutable controller revision and restrict permission to add `agent/dsh`, edit workflows, or change protection. The target workflows must emit the configured aggregate and exact base/head review checks; the installer bootstraps or merges their protection settings. Do not allow stale review status after the base changes. Keep App/PAT bootstrap credentials out of workflow secrets unless an unrelated workflow requirement explicitly needs one.

Install normally uses GitHub's [status check protection endpoint](https://docs.github.com/en/rest/branches/branch-protection#update-status-check-protection), preserves unrelated legacy contexts and app-bound checks, sets `strict=true`, and binds both the mapped CI aggregate and exact-head `codex/review` check to the GitHub Actions app ID `15368`. If the status-check endpoint returns an explicit `404`, the installer separately checks the full protection endpoint. Only when that endpoint also returns `404` does it use the [full update endpoint](https://docs.github.com/en/rest/branches/branch-protection#update-branch-protection) to create a minimal rule: strict app-bound checks, force pushes and branch deletion disabled, no user/team restrictions, and no manual approval requirement. It therefore does not add a human gate that would block a repository's already enabled GitHub auto-merge policy after the required checks pass. If protection already exists but its status-check facet is absent, install only attempts the narrow status-check update and fails closed if GitHub rejects it; it never reconstructs or overwrites existing review, restriction, history, or conversation rules. Every write is read back and verified. Uninstall never removes or relaxes protection. This automation supports GitHub.com only: the controller's reusable-workflow provenance depends on `job.workflow_*` data that is not available with the required semantics on GitHub Enterprise Server.

## Offline target workflow bootstrap

`bootstrap-repository.ps1` renders only the seven thin forwarding workflows under a local target checkout's `.github/workflows/` directory. It does not invoke GitHub CLI, read credentials, set repository variables, stage files, commit, or push. Supply the controller's owner/name, a reviewed lowercase 40-character commit SHA, and the CI workflow name that the target's `DSH_AUTOMATION_CI_WORKFLOW` variable must contain.

```powershell
pwsh -NoProfile -File F:\dsh-agent-automation\scripts\bootstrap-repository.ps1 `
  -TargetCheckout F:\target-repository `
  -ControllerRepository Ornn8/dsh-agent-automation `
  -ControllerSha 0123456789abcdef0123456789abcdef01234567 `
  -CiWorkflowName "Target CI" `
  -DryRun
```

The checkout argument must name the local Git root exactly. The renderer validates every generated workflow and every staged, unstaged, or untracked overlap before writing any file; use `-Update` only after reviewing that exact replacement. A matching rerun writes nothing. The generated health workflow has separate review and change roles. CI repair and CI-triggered landing subscribe to the rendered literal CI workflow name, then compare `DSH_AUTOMATION_CI_WORKFLOW` again before invoking a controller. Rework forwards that variable to repair, and recovery forwards failed controller runs to the hosted recovery workflow. Set the target variable through the ordinary installer or repository settings before committing the generated files.

## Autonomous repair budget

Automatic exact-review and failed-CI repair consumes at most six distinct controller-authored status markers for one pull request and one controller SHA. Each marker records the controller SHA and whether it represents automatic review, automatic CI, or explicit human repair. At the limit, the controller writes an English dead-letter status, adds `agent/dsh-failed`, clears automatic repair labels, and exits successfully without invoking a model, so recovery cannot recurse. A trusted explicit rework comment remains independently eligible and does not consume the automatic budget.

## Validate and install

These checks have no destructive or remote effect:

```powershell
pwsh -NoProfile -File F:\dsh-agent-automation\scripts\test-operations.ps1
pwsh -NoProfile -File F:\dsh-agent-automation\scripts\doctor.ps1 -Configuration F:\dsh-agent-automation-state\agent-config.json -DryRun
pwsh -NoProfile -File F:\dsh-agent-automation\scripts\install.ps1 -Configuration F:\dsh-agent-automation-state\agent-config.json -DryRun
```

Dry run validates and enumerates the exact instance IDs, task names, and operations runtime content hash. It makes no network call and creates, deletes, registers, starts, or stops nothing. The actual install rejects placeholder login/checksum values, verifies the pinned runner archive SHA-256, checks `github.login`, deploys and verifies the immutable operations runtime snapshot, sets each selected repository's CI workflow variable, merges and verifies its default-branch required checks, and registers only the selected instances:

```powershell
pwsh -NoProfile -File F:\dsh-agent-automation\scripts\install.ps1 -Configuration F:\dsh-agent-automation-state\agent-config.json
pwsh -NoProfile -File F:\dsh-agent-automation\scripts\install.ps1 -Configuration F:\dsh-agent-automation-state\agent-config.json -Roles review -Repositories Ornn8/deepseek-harness
pwsh -NoProfile -File F:\dsh-agent-automation\scripts\doctor.ps1 -Configuration F:\dsh-agent-automation-state\agent-config.json -Online
```

`-Repositories` is available only in `target-repositories` mode. `-NoStart` registers without starting. Existing `.runner` registrations and a hash-identical operations snapshot are retained; task definitions and repository variables are updated idempotently. Install also removes the obsolete exact task `DSH-Agent-Automation-controller` if it exists, without deleting its historical files.

Install compares the desired configuration and current checkout runtime hash with the installed manifest before changing repository variables or runner resources. A removed mapping, registration-scope switch, changed runner name/path, changed or invalid runtime snapshot, or untracked task/directory fails closed. Preview the exact reconciliation, then confirm it explicitly:

```powershell
pwsh -NoProfile -File F:\dsh-agent-automation\scripts\install.ps1 -Configuration F:\dsh-agent-automation-state\agent-config.json -Migrate -DryRun
pwsh -NoProfile -File F:\dsh-agent-automation\scripts\install.ps1 -Configuration F:\dsh-agent-automation-state\agent-config.json -Migrate -ConfirmMigration
```

Migration stops each obsolete instance, verifies its owned process identity, recursively terminates that process tree, removes its exact remote registration, unregisters its exact task, checks the runtime path and every nested item for reparse points, and deletes only that runner root. For an operations-code upgrade, it first stops every retained task, verifies that no task still references the old snapshot, removes that exact snapshot, deploys the new content hash, and re-registers the retained tasks without deleting their runner registration or work directory. Orphan snapshot directories are removed only through this explicit full migration; unknown files or reparse points in the snapshot root fail closed. The manifest is atomically updated after each completed instance so a retry resumes from known state. An untracked artifact whose ID is still desired can be adopted with the same explicit migration flags only when it is not a running legacy task without a PID record. If its ID is no longer desired, restore the previous configuration, adopt it, and then migrate to the new configuration; the scripts do not guess registration ownership.

Migration always reconciles the full configured topology and rejects `-Repositories` or a partial `-Roles` selection. Ordinary idempotent install and uninstall may still select one exact repository/role.

Normal doctor reconciles the desired instances with the manifest and discovered tasks/directories, verifies every runtime file hash and every task's exact snapshot script path, then checks every expected ACL, task/PID pair, executable, obsolete-controller state, and DSH Web Host task/PID pair. A different checkout hash is reported as a required explicit migration; it does not alter the running snapshot. `-Online` additionally verifies the GitHub principal, every mapped `DSH_AUTOMATION_CI_WORKFLOW` value, strict default-branch protection with both checks bound to app ID `15368`, and the loopback DSH RPC health endpoint. It diagnoses only; it does not repair or restart anything.

## Exact service control and fault injection

In target-repository mode, a worker command requires its repository and therefore resolves exactly one instance:

```powershell
pwsh -NoProfile -File F:\dsh-agent-automation\scripts\control.ps1 -Configuration F:\dsh-agent-automation-state\agent-config.json -Component review -Repository Ornn8/deepseek-harness -Action status
pwsh -NoProfile -File F:\dsh-agent-automation\scripts\control.ps1 -Configuration F:\dsh-agent-automation-state\agent-config.json -Component change -Repository Ornn8/deepseek-harness -Action restart
pwsh -NoProfile -File F:\dsh-agent-automation\scripts\control.ps1 -Configuration F:\dsh-agent-automation-state\agent-config.json -Component review -Repository Ornn8/deepseek-harness -Action fault
pwsh -NoProfile -File F:\dsh-agent-automation\scripts\control.ps1 -Configuration F:\dsh-agent-automation-state\agent-config.json -Component dsh-web -Action restart
```

In organization mode, omit `-Repository`. `fault` writes one marker within the private state root; only the selected supervisor consumes it and restarts its owned process. It does not modify a checkout or GitHub job. Do not inject a fault during work that must complete.

`stop` and `restart` first prevent the exact Scheduled Task from relaunching, then recursively terminate only the PID tree named by that instance's record and wait for both the task and owned root process to exit. `start`, `restart`, and fault injection require the manifest snapshot hashes and task script path to verify first; `stop` remains available to contain a damaged installation. `start` is idempotent when the task and PID record already agree. A running task without a valid ownership record, a reused PID, or an unreconciled manifest is an error; the scripts will not use a name-based process kill. These rules keep stopping one repository/role independent from all other instances.

## Uninstall and recovery

Inspect the exact scope first:

```powershell
pwsh -NoProfile -File F:\dsh-agent-automation\scripts\uninstall.ps1 -Configuration F:\dsh-agent-automation-state\agent-config.json -Roles review -Repositories Ornn8/deepseek-harness -ConfirmRemoval -DryRun
```

Actual uninstall requires `-ConfirmRemoval` and refuses unreconciled desired/installed state; run the explicit install migration first after a mapping or scope change. It stops and confirms the recursive exit of only each enumerated instance's owned process tree, then removes its exact task. The default retains the manifest entry, runner registration, and shared operations snapshot as an intentionally offline installation, so reinstall can restore the task idempotently. Add `-RemoveRunnerRegistration` to remove the matching remote registration. `-PurgeRuntime` requires `-RemoveRunnerRegistration`; after both succeed, uninstall deletes only the checked non-reparse runner directory and removes that entry from the manifest. The content-addressed operations snapshot is deleted only when `-PurgeRuntime` has removed the last runner entry and DSH Web Host is no longer managed; configuration and credentials are never part of that deletion. `-RemoveDshWebHost` applies the same owned-process stop rule to the host-wide task. Logs, work directories, machine-local configuration, `DSH_AUTOMATION_CI_WORKFLOW` repository variables, and branch-protection checks are always retained for audit and recovery.

If bootstrap or health checks fail, keep the runtime intact, run online doctor, and inspect the exact instance log. Re-run install after correction; instance IDs, paths, tasks, variables, and retained registrations are deterministic and idempotent.
