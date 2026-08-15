# Windows operations

This guide installs the local change and review workers. Pure GitHub coordination jobs run on GitHub-hosted runners; jobs that invoke or inspect a local Agent Worker, plus base reconciliation, run on the labeled self-hosted role runners. Repository supervision uses `agent-reviewer`; there is no separate local controller runner, task, label, or work directory.

## Runner topology

Two registration modes are supported:

| `registrationScope` | Local instances | Intended account topology |
| --- | --- | --- |
| `target-repositories` | The configured `change` and `review` replica counts for every `repositoryMapping` | Personal accounts and repositories that cannot share an organization runner. This is the example configuration. |
| `organization` | The configured shared `change` and `review` replica counts | Organizations whose runner group grants access to every allowlisted target. |

Target-repository instances have deterministic IDs derived from the full repository name plus a short SHA-256 suffix. Each instance has its own GitHub registration, Scheduled Task, runner root, work directory, supervisor log, and fault marker. `operations.roles.<role>.replicas` accepts 1 through 8 and defaults to 1 when omitted. Replica 1 keeps the original instance ID; additional instances append `-r2`, `-r3`, and so on. Runners with the same role label consume independent GitHub jobs concurrently, while workflow concurrency keys still serialize duplicate work for one Issue or pull request. The setting is independent of the selected DSH, OpenCode, Claude Code, Codex, or custom Adapter. Stopping one replica does not stop another role, repository, or replica. Organization runners are intentionally shared across all mapped repositories, so repository-level selection is rejected in that mode.

The optional `dsh-web` task is host-wide. Its hidden supervisor probes the loopback RPC endpoint and restarts only the process it started after repeated failures. Each configured `dsh-web` worker must include nonempty agent and permission preset names plus provider, model, and reasoning effort. The controller creates the session with that DSH agent preset, applies the permission preset through DSH's `/permission` command, applies the complete model selection through `session.selectModel`, verifies the required `dsh-github-work` Skill through `skill.list`, and only then submits one structured WorkRequest. Missing configuration, an unknown preset, plugin registration, or model selection fails before work starts. Plan mode remains an interactive DSH collaboration state and is not enabled for unattended work. Supervisor lifecycle and health logs are in `logsRoot`; GitHub runner diagnostics remain in each private runner directory.

## Configuration and paths

Use a dedicated Windows account. Install PowerShell 7 (`pwsh`), Git, GitHub CLI, Node, and every Adapter selected by a repository mapping. A `dsh-web` worker requires the DSH Web Host; `opencode-cli` and `claude-code-cli` require their respective executables and existing local authentication. Model credentials remain in those products' local configuration.

Copy [config.example.json](../config.example.json) to a machine-local file inside `stateRoot` on a data volume, for example `F:\dsh-agent-automation-state\agent-config.json`. Installed tasks continue to read that file, so it must not remain in a Git checkout. Configuration schema version 2 requires explicit `workers` and repository mappings; a `dsh-web` worker also requires explicit `agentPreset` and `permissionPreset` values, so it never inherits a mutable DSH UI default. Legacy top-level worker fields are rejected. The example is ready for an `Ornn8` personal-account topology and demonstrates repository-level registration; replace executable paths, runner release/version/hash, and target mappings as needed.

Set `github.login` to the exact GitHub CLI login on the host. Install and online doctor call `gh api user` and compare only the login, preventing another cached identity from operating the runners. They do not display the login returned by GitHub or any token.

Every `repositories` entry must have exactly one `repositoryMapping` with existing `changeWorker` and `reviewWorker` IDs plus nonempty `ciWorkflowName` and `ciRequiredCheckName` values. Controller jobs receive only the immutable `change` or `review` role and resolve the worker from this local exact mapping; a missing, duplicate, or unknown mapping fails before an agent starts. Changing either worker ID is sufficient to replace DSH, Codex, OpenCode, Claude Code, or a `command-json` integration without changing target workflows or GitHub work declarations. Role replica counts change only local GitHub job capacity; they do not create more Worker definitions or change routing. The latter mapping field is the aggregate check emitted by the target CI workflow, for example `all checks passed`. Install idempotently sets that target's Actions variable `DSH_AUTOMATION_CI_WORKFLOW` to the mapped workflow name. The value is routing configuration, not a secret. Uninstall intentionally retains it so disabling a local runner cannot silently alter repository configuration.

For `opencode-cli`, set `mode` to the assigned role, select the existing `provider/model` and variant, and provide `gitExecutable` for review. The Adapter discovers no repository-local OpenCode configuration: it mounts the controller-owned Skill in a temporary configuration directory. Review additionally uses OpenCode's `--pure` mode, disables default and Claude Code plugin discovery, and supplies a temporary primary agent that denies edits, shell commands, subagents, network tools, language servers, and questions while removing GitHub and provider-key environment variables. OpenCode's `--auto` flag therefore removes interactive prompts only for operations that the explicit review policy has not denied.

Run a real OpenCode adapter/provider smoke explicitly after installing or changing that adapter. The smoke creates a temporary two-commit repository, invokes the read-only review adapter with the selected provider, model, and variant, validates OpenCode's NDJSON session output, and deletes the repository. It is intentionally outside the default test suite because it consumes provider quota. With a temporary OpenCode CLI supplied by npm and a DeepSeek environment credential, run `npx --yes --package opencode-ai -- npm run smoke:opencode`; override `OPENCODE_SMOKE_EXECUTABLE`, `OPENCODE_SMOKE_MODEL`, `OPENCODE_SMOKE_VARIANT`, or `OPENCODE_SMOKE_CREDENTIAL_ENV` when the deployment uses different values. The script forwards only the named provider credential into the otherwise isolated reviewer environment and never prints its value.

For `claude-code-cli`, set `mode`, model, and effort, and provide `gitExecutable` for review. Change mode loads a temporary controller plugin and starts with `bypassPermissions`; use it only for the trusted change queue. Review disables Slash Commands, loads only the neutral project setting source, disables CLAUDE.md and auto memory, uses `dontAsk` with a fixed `Read,Glob,Grep` tool set, supplies a strict empty MCP configuration, disables Chrome, and removes GitHub and provider-key environment variables. It starts outside the pull-request checkout and receives only the controller review Skill, exact-pair input, and read-only additional directory.

`installRoot`, `stateRoot`, and `logsRoot` must be local absolute non-`C:` paths. The scripts reject `C:`, UNC paths, wildcards, volume roots, overlapping roots, mappings beyond the per-host limit, generated paths outside the managed roots, and an installed configuration outside `stateRoot`. Runtime/state directories are restricted to the installing user and `SYSTEM`. Recursive runtime removal rejects reparse points and operates only on enumerated instance or content-addressed runtime directories.

`stateRoot\install-manifest.json` is the authority for installed runner instances, registrations, exact paths, Scheduled Tasks, DSH Web Host ownership, and the installed operations runtime content hash. It contains no tokens or other credentials. Each supervisor also writes an atomic PID record under `stateRoot\pids`; the record binds the child PID to its exact process start time so PID reuse cannot authorize termination of another process. Keep `stateRoot` when editing mappings, role settings, or registration scope. To move `stateRoot`, first use the old configuration to remove all managed registrations and runtime, then install with the new configuration; a new state root cannot safely discover ownership recorded only in the old one.

Install hashes the operations module and both supervisor scripts, then copies exactly those three files into `installRoot\operations-runtime\<content-hash>`. The directory ACL grants the installing user and `SYSTEM` read/execute access; no configuration, credential, runner worktree, or checkout content is copied into it. Scheduled Tasks invoke only scripts in that manifest-recorded snapshot, so switching, updating, moving, or deleting the source checkout cannot silently change an installed service. Separately, install packs the credential-free `dsh-plugin` directory into a content-addressed tarball under `stateRoot\packages`, installs that tarball into the DSH `web` profile with the same CLI that launches the Web Host, and verifies the composed plugin row through `--dump-config` before starting the host.

## GitHub bootstrap permissions

Prefer a GitHub App or a fine-grained, short-lived PAT used through GitHub CLI. Do not place App keys, PATs, ephemeral runner tokens, or model keys in JSON, repository variables, workflow inputs, logs, or PowerShell history.

For `target-repositories`, the bootstrap identity needs each mapped repository's self-hosted runner administration permission, Actions Variables write permission, and repository Administration write permission for default-branch protection. For `organization`, it needs organization self-hosted runner administration and a runner group explicitly granted to every allowlisted target, plus Variables and Administration write permission for each target. A fine-grained PAT therefore needs repository Administration read/write in addition to runner and Variables permissions; a GitHub App installation needs the equivalent repository permissions. The installer fails closed when it cannot read or update required-status-check protection.

The installer requests an ephemeral registration token for each exact organization or target-repository instance and passes it only to that runner's `config.cmd`. Review workers receive no GitHub token. Repository variables are written through `gh variable set`; their values contain no credential material.

Repository setup must also provide the thin forwarding workflow pinned to an immutable controller revision and restrict permission to edit workflows or change protection. Trusted owners, members, and collaborators submit change work with the strict `agent-work:v1` Issue block documented in the repository README; `agent/dsh` remains a controller-visible queue projection and legacy manual trigger. The target workflows must emit the configured aggregate and exact base/head review checks; the installer bootstraps or merges their protection settings. Base reconciliation runs on the change-role runner with its verified host GitHub credential so an update-branch mutation emits the ordinary pull-request events that rerun both CI and review; never substitute the Actions job token, whose mutations suppress those downstream workflows. Keep App/PAT bootstrap credentials out of workflow secrets unless an unrelated workflow requirement explicitly needs one.

Install normally uses GitHub's [status check protection endpoint](https://docs.github.com/en/rest/branches/branch-protection#update-status-check-protection), preserves unrelated legacy contexts and app-bound checks, sets `strict=true`, and binds both the mapped CI aggregate and exact-head `codex/review` check to the GitHub Actions app ID `15368`. If the status-check endpoint returns an explicit `404`, the installer separately checks the full protection endpoint. Only when that endpoint also returns `404` does it use the [full update endpoint](https://docs.github.com/en/rest/branches/branch-protection#update-branch-protection) to create a minimal rule: strict app-bound checks, force pushes and branch deletion disabled, no user/team restrictions, and no manual approval requirement. It therefore does not add a human gate that would block a repository's already enabled GitHub auto-merge policy after the required checks pass. If protection already exists but its status-check facet is absent, install only attempts the narrow status-check update and fails closed if GitHub rejects it; it never reconstructs or overwrites existing review, restriction, history, or conversation rules. Every write is read back and verified. Uninstall never removes or relaxes protection. This automation supports GitHub.com only: the controller's reusable-workflow provenance depends on `job.workflow_*` data that is not available with the required semantics on GitHub Enterprise Server.

## Offline target workflow bootstrap

`bootstrap-repository.ps1` renders only the eight thin forwarding workflows under a local target checkout's `.github/workflows/` directory, including scheduled repository supervision. It does not invoke GitHub CLI, read credentials, set repository variables, stage files, commit, or push. Supply the controller's owner/name, a published lowercase 40-character `ControllerSha` that remains permanently reachable from the controller default branch, the CI workflow name that the target's `DSH_AUTOMATION_CI_WORKFLOW` variable must contain, and the exact upstream owner/repository audited by supervision. If a controller PR is squash- or rebase-merged, verify that the published commit tree exactly matches the reviewed PR-head tree before pinning the published commit; never pin a PR head from a branch that may be deleted. The offline renderer does not verify GitHub reachability.

GitHub does not start ordinary downstream workflows for labels written by a workflow's own `GITHUB_TOKEN`. Issue opened, reopened, and edited events reevaluate `agent-work:v1`; backlog, reconciliation, and bounded recovery use the supported `repository_dispatch` exception for their Issue and exact-pair review handoffs. Target listeners live on the protected default branch, reusable jobs remain pinned to the published controller SHA, and each worker revalidates the live Issue or exact pull request base/head before any model call. Labels remain observable audit state, never independent execution authority.

```powershell
pwsh -NoProfile -File F:\dsh-agent-automation\scripts\bootstrap-repository.ps1 `
  -TargetCheckout F:\target-repository `
  -ControllerRepository Ornn8/dsh-agent-automation `
  -ControllerSha 0123456789abcdef0123456789abcdef01234567 `
  -CiWorkflowName "Target CI" `
  -UpstreamRepository deepseek-ai/deepseek-harness `
  -DryRun
```

The checkout argument must name the local Git root exactly. The renderer validates every generated workflow and every staged, unstaged, or untracked overlap before writing any file; use `-Update` only after reviewing that exact replacement. A matching rerun writes nothing. The generated health workflow has separate review and change roles. CI repair and CI-triggered landing subscribe to the rendered literal CI workflow name, then compare `DSH_AUTOMATION_CI_WORKFLOW` again before invoking a controller. Rework forwards that variable to repair, recovery forwards failed controller runs to the hosted recovery workflow, and repository supervision runs an offset six-hour schedule plus a manual dry-run entry point against the rendered upstream repository. Set the target variable through the ordinary installer or repository settings before committing the generated files.

## Autonomous repair budget

Automatic exact-review and failed-CI repair consumes at most six distinct controller-authored status markers for one pull request and one controller SHA. Each marker records the controller SHA and whether it represents automatic review, automatic CI, or explicit human repair. At the limit, the controller writes an English dead-letter status, adds `agent/dsh-failed`, clears automatic repair labels, and exits successfully without invoking a model, so recovery cannot recurse. A trusted explicit rework comment remains independently eligible and does not consume the automatic budget.

## Validate and install

These checks have no destructive or remote effect:

```powershell
pwsh -NoProfile -File F:\dsh-agent-automation\scripts\test-operations.ps1
pwsh -NoProfile -File F:\dsh-agent-automation\scripts\doctor.ps1 -Configuration F:\dsh-agent-automation-state\agent-config.json -DryRun
pwsh -NoProfile -File F:\dsh-agent-automation\scripts\install.ps1 -Configuration F:\dsh-agent-automation-state\agent-config.json -DryRun
```

Dry run validates and enumerates the exact instance IDs, task names, operations runtime content hash, and DSH plugin install action. It makes no network call and creates, deletes, registers, starts, or stops nothing. The actual install rejects placeholder login/checksum values, verifies the pinned runner archive SHA-256, checks `github.login`, deploys and verifies the immutable operations runtime snapshot, installs the DSH work bundle, sets each selected repository's CI workflow variable, merges and verifies its default-branch required checks, and registers only the selected instances:

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

In target-repository mode, a worker command requires its repository. `-Replica` defaults to 1 and selects one exact runner:

```powershell
pwsh -NoProfile -File F:\dsh-agent-automation\scripts\control.ps1 -Configuration F:\dsh-agent-automation-state\agent-config.json -Component review -Repository Ornn8/deepseek-harness -Action status
pwsh -NoProfile -File F:\dsh-agent-automation\scripts\control.ps1 -Configuration F:\dsh-agent-automation-state\agent-config.json -Component change -Repository Ornn8/deepseek-harness -Action restart
pwsh -NoProfile -File F:\dsh-agent-automation\scripts\control.ps1 -Configuration F:\dsh-agent-automation-state\agent-config.json -Component change -Repository Ornn8/deepseek-harness -Replica 2 -Action status
pwsh -NoProfile -File F:\dsh-agent-automation\scripts\control.ps1 -Configuration F:\dsh-agent-automation-state\agent-config.json -Component review -Repository Ornn8/deepseek-harness -Action fault
pwsh -NoProfile -File F:\dsh-agent-automation\scripts\control.ps1 -Configuration F:\dsh-agent-automation-state\agent-config.json -Component dsh-web -Action restart
```

In organization mode, omit `-Repository` and use `-Replica` when selecting a replica after the first. `fault` writes one marker within the private state root; only the selected supervisor consumes it and restarts its owned process. It does not modify a checkout or GitHub job. Do not inject a fault during work that must complete.

`stop` and `restart` first prevent the exact Scheduled Task from relaunching, then recursively terminate only the PID tree named by that instance's record and wait for both the task and owned root process to exit. `start`, `restart`, and fault injection require the manifest snapshot hashes and task script path to verify first; `stop` remains available to contain a damaged installation. `start` is idempotent when the task and PID record already agree. A running task without a valid ownership record, a reused PID, or an unreconciled manifest is an error; the scripts will not use a name-based process kill. These rules keep stopping one repository/role independent from all other instances.

## Uninstall and recovery

Inspect the exact scope first:

```powershell
pwsh -NoProfile -File F:\dsh-agent-automation\scripts\uninstall.ps1 -Configuration F:\dsh-agent-automation-state\agent-config.json -Roles review -Repositories Ornn8/deepseek-harness -ConfirmRemoval -DryRun
```

Actual uninstall requires `-ConfirmRemoval` and refuses unreconciled desired/installed state; run the explicit install migration first after a mapping or scope change. It stops and confirms the recursive exit of only each enumerated instance's owned process tree, then removes its exact task. The default retains the manifest entry, runner registration, shared operations snapshot, DSH plugin profile entry, and content-addressed plugin tarball as an intentionally offline installation, so reinstall can restore the task idempotently and stopping this controller does not modify the user's DSH composition. Add `-RemoveRunnerRegistration` to remove the matching remote registration. `-PurgeRuntime` requires `-RemoveRunnerRegistration`; after both succeed, uninstall deletes only the checked non-reparse runner directory and removes that entry from the manifest. The content-addressed operations snapshot is deleted only when `-PurgeRuntime` has removed the last runner entry and DSH Web Host is no longer managed; configuration and credentials are never part of that deletion. `-RemoveDshWebHost` applies the same owned-process stop rule to the host-wide task. Logs, work directories, machine-local configuration, `DSH_AUTOMATION_CI_WORKFLOW` repository variables, and branch-protection checks are always retained for audit and recovery.

If bootstrap or health checks fail, keep the runtime intact, run online doctor, and inspect the exact instance log. Re-run install after correction; instance IDs, paths, tasks, variables, and retained registrations are deterministic and idempotent.
