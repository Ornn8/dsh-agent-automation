# Coordinator V2 boundary

Coordinator V2 is a GitHub-native scheduler for independently operated Agents. It is built beside the legacy control plane and does not import legacy state or runtime modules.

## Core lifecycle

```text
Issue task
  -> current-state eligibility
  -> one expiring GitHub claim
  -> independent Agent branch and pull request
  -> target CI plus exact-pair independent review
  -> current-state reconciliation
  -> merge or bounded repair
  -> dependency unlock
```

Every event is only a wake signal. Before a mutation, the coordinator reloads current GitHub state and evaluates one pure policy. Repeated, delayed, reordered, or scheduled wakes therefore produce the same decision for the same snapshot.

## Task protocol

An executable Issue contains objective, scope, acceptance criteria, and one declaration:

````markdown
## Objective

Implement one bounded behavior.

## Scope

Only the independently reviewable change.

## Acceptance criteria

- Target CI passes.

<!-- agent-task:v1 -->
```json
{"version":1,"dispatch":"ready","dependsOn":[]}
```
````

The declaration contains no Profile, Stage, Worker, Adapter, provider, model, account, credential, prompt, or command. Different repository/Issue subjects always receive different task identities. Dependencies are explicit Issue numbers and are the only V2 business-ordering primitive.

## Task claim protocol

A ready task may have one controller-authenticated `agent-task-claim:v1` projection. The projection binds the repository, Issue number, current task identity, claimant runtime identity, creation time, expiry time, and deterministic claim id.

- Lease duration is supplied by bounded Coordinator configuration, never by Issue text or Agent output.
- One unexpired claim makes the exact task busy.
- Repeated observations of the same claim are idempotent.
- Two different unexpired claims for the same task fail closed as a conflict.
- An expired claim or a claim for an older task identity does not block replacement.
- Unauthenticated comments are ignored; a malformed authenticated claim fails closed.
- A claim controls task exclusivity only. It does not authorize code, review, merge, or any other Issue.

The pure policy consumes normalized authenticated observations. No database or local lock is introduced.

### Claim comment authority

The durable GitHub projection is one controller-owned Issue comment whose body starts with `<!-- coordinator-v2-task-claim -->`. A comment becomes authoritative only when its canonical payload, expected Bot application identity, target repository and Issue, pinned Controller workflow and full revision, and positive source run id and attempt all agree with a live normalized Actions-run observation.

- Human or Agent comments are unauthenticated noise even when they copy the marker.
- A trusted-author comment with a malformed marker or payload fails closed.
- Repeated observations of one comment id are idempotent; two distinct controller comments conflict.
- The GitHub gateway bounds raw pagination before materializing comments and converts only literal boolean authentication results into policy observations.
- GitHub timestamps, nullable Issue bodies, claimant casing, and open task pull requests are normalized at the gateway boundary.
- Rendering and provenance verification are pure; comment creation, update, reread, and Issue-scoped concurrency are separate mutation work.

## Ready-set policy

One bounded repository snapshot is evaluated into a proposed batch of tasks that may attempt claim acquisition.

- Open task pull requests and current claims consume repository slots.
- Explicit open dependencies wait; closed dependencies satisfy their edge.
- Invalid tasks and claim conflicts are excluded without suppressing unrelated valid work.
- Repository active-task limits and per-run batch limits remain separate trusted settings.
- An explicitly requested Issue is first only when it is otherwise eligible.
- Ordinary ordering is ascending Issue number and does not depend on API response order.
- Selection creates no authority: the serialized GitHub gateway rereads the exact task before creating a claim.

The selector never infers product conflicts, chooses a Worker, or inspects provider capacity.

## Pull-request policy

The evaluator consumes only the current pull request, exact-head CI result, exact-base/head review result, and bounded repair state. It returns one closed action:

- `request-review`
- `wait-review`
- `wait-checks`
- `request-repair`
- `wait-repair`
- `wait-mergeable`
- `request-merge`
- `paused`
- `blocked`
- `terminal`

CI-first and review-first event order converge on the same result. Evidence for another head or base/head pair is treated as missing.

## Explicit exclusions

Coordinator V2 does not own:

- Agent process or workspace lifecycle;
- model/provider/account selection;
- quota, billing, cooldown, half-open, or credential state;
- repository planning or Issue decomposition;
- Controller self-repair or self-promotion;
- a second workflow database beside GitHub;
- product verification commands beyond observing target CI.

These concerns live in an Agent runtime, a planning Agent, ordinary repository maintenance, or the target repository itself.

## Migration rule

Legacy production workflows remain unchanged until V2 shadow decisions match historical incident fixtures and a disposable target passes end to end. New legacy mechanisms are not added to satisfy V2 requirements.
