# Coordinator V2 centralized Claim workflow

The Claim mutation workflow runs in the Controller repository. It is not installed in target repositories and is not part of the legacy bootstrap set.

## Why it is centralized

A Claim comment is authoritative only when it is published by one dedicated claim-writer GitHub App. Keeping that App private key in a target repository would allow another sufficiently privileged target workflow to request the same secret and impersonate the Claim gateway.

The Controller-repository workflow instead owns the only credential path:

```text
manual disposable-target request
  -> Controller workflow_dispatch
  -> explicit target allowlist
  -> Issue-scoped Controller concurrency group
  -> target-scoped App installation token
  -> complete target state read
  -> Claim create/update
  -> complete target state reread
  -> closed machine result
```

The workflow performs no Agent dispatch. `acquired` means only that the exact current task had the intended authenticated Claim after the post-write reread.

## Serialization

The complete read/write/reread operation runs under:

```text
coordinator-v2-claim:<target-repository>:<issue-number>
```

with `cancel-in-progress: false`. GitHub Actions concurrency is repository-scoped, so every path that can use the dedicated App credential must remain in this Controller repository and use the same group. A workflow in another repository or a manual tool holding the same key would be an unsafe bypass.

The workflow requires a lowercase repository input and a canonical positive Issue number before creating the App token. These values form the concurrency key, so alternate casing or leading-zero representations cannot create a second valid mutation lane.

A replaced pending wake is acceptable because later reconciliation can submit the same current task again. The running mutation is never canceled.

## Permissions and credentials

The workflow's ordinary `GITHUB_TOKEN` has only `actions: read` and `contents: read`. It reads the central source run and checks out the exact workflow revision.

The `coordinator-v2-claim` environment must define:

- variable `COORDINATOR_V2_CLAIM_APP_CLIENT_ID`;
- secret `COORDINATOR_V2_CLAIM_APP_PRIVATE_KEY`;
- variable `COORDINATOR_V2_CLAIM_ALLOWED_REPOSITORIES_JSON`, a non-empty JSON array of at most 64 explicit `owner/name` targets.

The environment deployment-branch rule must allow only the protected Controller `master` branch. A non-default branch must not be able to modify this workflow and then request the same App private key. This repository setting is part of the credential-isolation boundary and cannot be proven by the workflow file alone.

The requested target must appear in the allowlist before an App token is created. During disposable-target acceptance the allowlist contains only that disposable repository; it must not contain `shanyin-tea-commerce`.

The dedicated App token is scoped to the one named target repository with only:

- Issues: write;
- Pull requests: read;
- implicit repository metadata read.

The App key must not be copied to a target repository, an Agent runtime, another Controller workflow, or an operator script.

## Source-run meaning

The Claim comment references the central Controller workflow run. The verifier requires the run id, attempt, Controller repository, workflow path, and full head SHA to agree.

This is provenance consistency, not proof that GitHub attached the run identity to the IssueComment creation event. Application-level authority comes from the dedicated App identity and credential isolation.

## Snapshot boundary

The adapter reads:

- the exact Issue and trusted author association;
- every explicit dependency in the current declaration;
- same-repository open pull requests that GitHub reports as closing the Issue;
- the complete Issue comment collection within bounded item and byte limits;
- the central workflow run through the Controller `GITHUB_TOKEN`.

GitHub `body: null` becomes an empty string. Cross-repository and closed pull requests are excluded. Partial comment materialization fails closed.

## Initial activation

The first workflow trigger is `workflow_dispatch` on the Controller default branch. It is for a disposable target only. No target template or bootstrap file is changed, and `shanyin-tea-commerce` remains on the legacy path.

Automated wakes require a later reviewed Controller-side dispatcher or GitHub App webhook. No Agent may start directly from this workflow result; dispatch must first reread the Claim with a fresh observation time.