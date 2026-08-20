# Machine configuration reference

This document is a field catalog, not an executable configuration. Start from [`config.minimal.json`](../config.minimal.json), copy it into the machine state directory, and change only the fields required by the deployment. Run `scripts/doctor.ps1 -Configuration <path> -Explain -DryRun` to see the effective local configuration before installation.

## Resolution model

The public file contains intent. [`ops/config.defaults.json`](../ops/config.defaults.json) supplies ordinary host defaults. The loader then derives repositories, Worker roles, capabilities, executable defaults, maintenance credential paths, the selected runner artifact, and a `configurationHash`. Repository variables may override the configured CI workflow and required-check lists at runtime. `doctor.ps1 -Explain` reports every effective leaf with its declared value, source file and line, and any repository-variable override.

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

Every Worker requires `adapter`. The Adapter determines the remaining fields. Role-owned values are not accepted in the Worker object: `mode`, capabilities, review isolation, and maintenance `githubLogin` are derived from `operations.roles` and the Adapter implementation. `capacityGroup` defaults to the Worker id when it is a routing identifier; legacy Worker ids containing other characters receive a stable `worker-<sha256>` default and require no configuration migration. A capacity group identifies a machine-local capacity boundary for later capacity handling; it does not activate failover. `routingTags` defaults to an empty list and is only metadata for the bounded route selectors.

| Adapter | Required fields | Optional fields |
| --- | --- | --- |
| `dsh-web` | `baseUrl`, `agentPreset`, `permissionPreset`, `provider`, `model`, `reasoningEffort` | `capacityGroup`, `routingTags` |
| `codex-app` | `node`, `script`, `home`, `model`, `effort`, `keep` | `capacityGroup`, `routingTags` |
| `opencode-cli` | `model`, `variant` | `executable`, `agent`, `credentialIsolationDir`, `healthArgs`, `capacityGroup`, `routingTags` |
| `claude-code-cli` | `model`, `effort` | `executable`, `credentialIsolationDir`, `healthArgs`, `capacityGroup`, `routingTags` |
| `command-json` | `executable` | `args`, `healthArgs`, `credentialIsolationDir`, `capacityGroup`, `routingTags` |

`executable` defaults to `opencode` for OpenCode and `claude` for Claude Code. Windows deployments must override it with a native executable when the discovered command is a `.cmd`, `.bat`, or `.ps1` shim because Agent processes start without a command shell. A review Worker also derives `gitExecutable`. A maintenance Worker derives `credentialIsolationDir` under `operations.stateRoot` unless it is explicitly configured. `args` are the command-json invocation arguments; `healthArgs` replace normal arguments for a keyless readiness check. `agent` selects an OpenCode Agent. Review workspace paths are not configurable: installation derives one fixed slot and lease from `operations.stateRoot` and each exact review replica id. `keep` limits retained Codex review tasks. `effort` and `reasoningEffort` are Adapter-specific reasoning controls.

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
| `roles` | Yes | None | The role admission pools and runner topology. Change and review pools are bounded to eight Workers. |
| `routing` | No | Default route per change/review role | Ordered, bounded route selectors for change and review. The generated default route selects the first admitted Worker, preserving the existing single-Worker behavior. |
| `dshWebHost` | No | Disabled | Optional supervised local DSH Web Host. |

### Runner artifacts

Each entry in `artifacts` is named `windows-x64`, `windows-arm64`, `linux-x64`, `linux-arm64`, `macos-x64`, or `macos-arm64`. Each entry requires an HTTPS `downloadUri` and official 64-character `sha256`. Installation selects the current or requested platform; the selected platform and artifact values are derived rather than duplicated in the public file.

### Repository mappings

Each item requires `repository`, `ciWorkflows`, and `requiredChecks`. `repositoryMappings` is the product-target allowlist: a mapping must not equal `controller.repository`, even with different letter casing. Both lists contain unique, nonempty GitHub display names. Installation projects them to `DSH_AUTOMATION_CI_WORKFLOWS`, `DSH_AUTOMATION_REQUIRED_CHECKS`, and the trust-bearing `AGENT_AUTOMATION_CONTROLLER_LOGIN`, which must equal `github.login`. The two JSON repository variables are mutable routing configuration, not authority; `doctor.ps1 -Explain` shows their remote source and status. The trusted review check is controller-owned and must not appear in `requiredChecks`. The Node and PowerShell loaders reject a self-target before installation, planning, or Worker startup.

### Roles

`roles` has exactly `change`, `review`, and `maintenance`. Each role requires `workers`; every role accepts one through eight Workers. A Worker cannot appear in two roles. The change and review pools are admission allowlists; PR1 does not activate runtime failover.

Each role may set `runnerNamePrefix`, `replicas`, and `labels`. Defaults are `agent-change`/`agent-change`, `agent-review`/`agent-reviewer`, and `agent-maint`/`agent-maintenance`; every role defaults to one replica. The maintenance role is fixed to one replica. Required role labels cannot be removed.

### Routing

`routing.change.routes` and `routing.review.routes` are bounded named route maps. Each role routing object may set `maxCandidates` from 1 through 8 (default 8). The `routes` map contains named route objects, and every route has one through sixteen ordered `selectors`; a selector is exactly one of `{ "worker": "id" }`, `{ "allTags": ["tag"] }`, or `{ "route": "other-route" }`. Worker selectors name an admitted Worker id exactly, including ids accepted before routing existed. Tags are unique and matched with ordinal, case-sensitive equality; tag selectors order matching Worker ids by ordinal code-unit order. Route references must be acyclic and are compiled once per resolution with shared subgraphs memoized. Every non-default route must resolve to at least one admitted Worker, and review routes may contain only Workers with hard read-only isolation. When routing is omitted, the loader derives a `default` route selecting the first role Worker. Maintenance review executes only the first candidate from the review `default` route. Candidate resolution is deterministic and only provides selection metadata; PR1 does not perform failover or capacity selection.

### DSH Web Host

`dshWebHost.enabled` defaults to false. When true, `executable`, `arguments`, `workingDirectory`, and loopback `baseUrl` are required. `restartAfterFailures` defaults to 3. Health uses the fixed protocol path `/api/session.list` and also verifies `/api/llm.providers` and `/api/llm.models` for every configured `dsh-web` worker on that base URL; these paths are not configurable because changing them would change the Adapter protocol rather than deployment policy.

## Removed machine fields

The loader rejects these pre-release fields so a stale file cannot appear to work with different semantics:

- `schemaVersion`, `configRevision`, and `operations.schemaVersion`: replaced by strict parsing plus the derived configuration identity.
- `credentialRevision`: renamed to `credentialGeneration` to state that it is an operator signal, not a document revision.
- top-level `repositories`: derived from `operations.repositoryMappings`.
- top-level `maintenanceWorkers` and `maintenanceReviewWorker`: replaced by `operations.roles.maintenance.workers` and `operations.roles.review.workers`.
- mapping-local `changeWorker` and `reviewWorker`: replaced by the global role routing table.
- Worker-local `mode`, capabilities, and `githubLogin`: derived from the role and Adapter.
- Worker-local `projectCwd`: replaced by the registered review replica workspace derived from `operations.stateRoot`.

## Explain output

`scripts/doctor.ps1 -Explain -DryRun` is offline and reports `configuration`, `default`, and `derived` values, including every planned review workspace. Without `-DryRun`, it also reads the four required repository projections, marks overrides, reports each slot as available, leased, stale, invalid, or missing, and fails if a required projection is missing or the controller login differs. The human table is followed by `AUTOMATION_CONFIGURATION_EXPLAIN_JSON=...` for scripts. Each record contains `Path`, effective `Value`, `DeclaredValue`, `SourceType`, `Source`, `Line`, `Override`, and `Status`; workspace records also contain `Detail` and the current `Repository` binding read from the lease or local origin.
