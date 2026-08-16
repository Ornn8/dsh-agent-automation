# Machine configuration reference

This document is a field catalog, not an executable configuration. Start from [`config.minimal.json`](../config.minimal.json), copy it into the machine state directory, and change only the fields required by the deployment. Run `scripts/doctor.ps1 -Configuration <path> -Explain -DryRun` to see the effective local configuration before installation.

## Resolution model

The public file contains intent. [`ops/config.defaults.json`](../ops/config.defaults.json) supplies ordinary host defaults. The loader then derives repositories, Worker roles, capabilities, executable defaults, the selected runner artifact, and a `configurationHash`. Repository variables may override the configured CI workflow and required-check lists at runtime. `doctor.ps1 -Explain` reports every effective leaf with its declared value, source file and line, and any repository-variable override.

`$schema` is an editor hint, not a revision counter. This pre-release repository rejects removed fields instead of migrating them silently. `credentialGeneration` is the only operator-controlled revision signal: increment its non-secret value after rotating a credential. The controller derives `configurationHash` from all non-credential effective settings; it is not a public input. Durable runtime records keep their own internal `schemaVersion` fields, which are unrelated to this machine configuration.

## Root fields

| Field | Required | Default | Meaning |
| --- | --- | --- | --- |
| `$schema` | No | None | JSON Schema URL for editor validation. |
| `credentialGeneration` | Yes | None | Non-secret operator generation for credentials. It does not contain or identify a secret. |
| `ghExecutable` | No | `gh` | GitHub CLI command or absolute executable path. |
| `gitExecutable` | No | `git` | Git command or absolute executable path. |
| `github.login` | Yes | None | Expected GitHub login for the host credential. |
| `workers` | Yes | None | Named Worker Adapter settings. Every Worker must be assigned to exactly one role. |
| `operations` | Yes | None | Host, runner, repository, and role settings. |

## Worker fields

Every Worker requires `adapter`. The Adapter determines the remaining fields. Role-owned values are not accepted in the Worker object: `mode`, capabilities, and review isolation are derived from `operations.roles` and the Adapter implementation.

| Adapter | Required fields | Optional fields |
| --- | --- | --- |
| `dsh-web` | `baseUrl`, `agentPreset`, `permissionPreset`, `provider`, `model`, `reasoningEffort` | None |
| `codex-app` | `node`, `script`, `home`, `model`, `effort`, `keep` | `projectCwd` |
| `opencode-cli` | `model`, `variant` | `executable`, `agent`, `healthArgs` |
| `claude-code-cli` | `model`, `effort` | `executable`, `healthArgs` |
| `command-json` | `executable` | `args`, `healthArgs` |

`executable` defaults to `opencode` for OpenCode and `claude` for Claude Code. A review Worker also derives `gitExecutable`. `args` are the command-json invocation arguments; `healthArgs` replace normal arguments for a keyless readiness check. `agent` selects an OpenCode Agent. `projectCwd` selects the Codex Desktop project directory. `keep` limits visible Codex review tasks. `effort` and `reasoningEffort` are Adapter-specific reasoning controls.

## Operations fields

| Field | Required | Default | Meaning |
| --- | --- | --- | --- |
| `installRoot` | No | `${CONFIG_DIR}/runtime` | Installed runner and immutable Operations runtime root. |
| `stateRoot` | No | `${CONFIG_DIR}` | Machine state root; the configuration file must live below it for a real install. |
| `logsRoot` | No | `${CONFIG_DIR}/logs` | Log root below `stateRoot`. |
| `controller.repository` | Yes | None | Controller `owner/repository`. |
| `controller.registrationScope` | No | `target-repositories` | `target-repositories` creates per-repository runners; `organization` creates shared runners. |
| `controller.organization` | For organization scope | None | Organization used for shared runner registration. |
| `runner.version` | Yes | None | Pinned Actions runner version, at least 2.334.0. |
| `runner.artifacts` | Yes | None | Platform-keyed official runner archives. |
| `repositoryMappings` | Yes | None | Target repositories and their declared CI projection. |
| `roles` | Yes | None | The single role-to-Worker routing table and runner topology. |
| `dshWebHost` | No | Disabled | Optional supervised local DSH Web Host. |

### Runner artifacts

Each entry in `artifacts` is named `windows-x64`, `windows-arm64`, `linux-x64`, `linux-arm64`, `macos-x64`, or `macos-arm64`. Each entry requires an HTTPS `downloadUri` and official 64-character `sha256`. Installation selects the current or requested platform; the selected platform and artifact values are derived rather than duplicated in the public file.

### Repository mappings

Each item requires `repository`, `ciWorkflows`, and `requiredChecks`. Both lists contain unique, nonempty GitHub display names. Installation projects them to `DSH_AUTOMATION_CI_WORKFLOWS` and `DSH_AUTOMATION_REQUIRED_CHECKS`. Those repository variables are mutable routing configuration, not authority; `doctor.ps1 -Explain` shows when they override the file. The trusted review check is controller-owned and must not appear in `requiredChecks`.

### Roles

`roles` has exactly `change` and `review`. Each role requires one Worker, and a Worker cannot appear in both roles.

Each role may set `runnerNamePrefix`, `replicas`, and `labels`. Defaults are `agent-change`/`agent-change` and `agent-review`/`agent-reviewer`; every role defaults to one replica. Required role labels cannot be removed.

### DSH Web Host

`dshWebHost.enabled` defaults to false. When true, `executable`, `arguments`, `workingDirectory`, and loopback `baseUrl` are required. `restartAfterFailures` defaults to 3. The health endpoint is the fixed protocol path `/api/session.list`; it is not configurable because changing it would change the Adapter protocol rather than deployment policy.

## Removed machine fields

The loader rejects these pre-release fields so a stale file cannot appear to work with different semantics:

- `schemaVersion`, `configRevision`, and `operations.schemaVersion`: replaced by strict parsing plus the derived configuration identity.
- `credentialRevision`: renamed to `credentialGeneration` to state that it is an operator signal, not a document revision.
- top-level `repositories`: derived from `operations.repositoryMappings`.
- top-level `maintenanceWorkers` and `maintenanceReviewWorker`: unsupported until the independent maintenance topology is introduced.
- mapping-local `changeWorker` and `reviewWorker`: replaced by the global role routing table.
- Worker-local `mode`, capabilities, and `githubLogin`: derived from the role and Adapter.

## Explain output

`scripts/doctor.ps1 -Explain -DryRun` is offline and reports `configuration`, `default`, and `derived` values. Without `-DryRun`, it also reads the two required repository variables, marks overrides, and fails if one is missing. The human table is followed by `AUTOMATION_CONFIGURATION_EXPLAIN_JSON=...` for scripts. Each record contains `Path`, effective `Value`, `DeclaredValue`, `SourceType`, `Source`, `Line`, `Override`, and `Status`.
