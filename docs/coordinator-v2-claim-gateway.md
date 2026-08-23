# Coordinator V2 Claim mutation gateway

The Claim mutation gateway is the only V2 component allowed to create or replace the dedicated Claim Issue comment. It composes the reviewed task, Claim, and Claim-comment policies; it does not start an Agent.

## Serialization contract

The entry point must run under one external Issue-scoped serialization key:

```text
coordinator-v2-claim:<owner>/<repository>:<issue-number>
```

The function does not create a database or local lock. Until the thin target workflow supplies this GitHub Actions concurrency boundary, the gateway is not enabled in production.

## Current-state flow

For one bounded request the gateway:

1. validates the expected task identity, claimant, lease, dedicated App authority, Controller provenance, and current source run;
2. loads one complete normalized task snapshot;
3. re-evaluates Issue trust, declaration, explicit dependencies, and open task pull requests;
4. verifies the current dedicated-App Claim comment, when present;
5. decides `existing`, `busy`, `ineligible`, `blocked`, or `create` through the pure Claim policy;
6. creates or replaces one canonical Claim comment;
7. reloads the complete task snapshot after the write;
8. requires the task to remain ready and the written comment to equal the intended authenticated projection before reporting `acquired`.

An Issue edit, dependency change, new pull request, duplicate dedicated-App comment, changed write result, or mismatched reread prevents Agent dispatch.

## Trusted configuration

The request contains only repository, Issue number, expected task identity, and claimant runtime identity. Lease duration, observation time, dedicated App identity, Controller repository/workflow/full SHA, and source run id/attempt are trusted gateway configuration.

The dedicated App credential must be isolated to this gateway. The source run proves provenance consistency; it does not prove that the referenced run itself created the Issue comment.

## Snapshot boundary

The injected GitHub adapter returns one complete normalized snapshot containing:

- the current Issue and trusted-author decision;
- every explicit dependency observation;
- only current open task pull requests for the same repository and Issue;
- a complete bounded comment list.

GitHub `null` Issue bodies are normalized to an empty string. The adapter must stop pagination honestly rather than marking a partial snapshot complete.

## Closed outcomes

The gateway returns only:

- `acquired`
- `existing`
- `busy`
- `ineligible`
- `blocked`

No result authorizes code, review, repair, or merge. `acquired` means only that the exact current task owns one verified Claim comment after the post-write reread.
