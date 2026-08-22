# Windows capacity lease identity probes

## Problem

On Windows, every independent capacity-registry contender launched a PowerShell `Get-Process` probe to write its own lease identity. A full-suite runner can start many contenders at once, so process-start inspection became the shared resource that the lock was meant to protect.

## Decision

Fresh Windows leases using the live clock store the owner PID and acquisition timestamp without probing the owner process. When an expired lease is inspected, the trusted Windows start-time probe is required and the lease remains held only when the observed process started no later than the recorded acquisition. Existing leases with an explicit process identity continue to use exact identity equality. Unknown, malformed, timed-out, or inaccessible identity evidence keeps the lease held or fails the acquisition; it never authorizes reclamation. Deterministic injected clocks retain the explicit identity field so timestamp comparisons do not depend on a synthetic wall clock. The public facade preserves whether its caller supplied that clock when it normalizes the lock options.

## Alternatives considered

**Increase the identity timeout.** Rejected because it leaves the one-probe-per-contender amplification intact and makes a shared runner wait longer under load.

**Reduce the 24-process test or serialize the test suite.** Rejected because it hides the production contention pattern instead of fixing the process-start launcher cost.

**Cache Windows identities across processes.** Rejected because a PID-keyed cache cannot prove that a PID was not reused after the cached process exited. The acquisition timestamp gives a fail-closed comparison without sharing stale identity observations.

## Consequences

Normal Windows lock acquisition does not start an external identity process. Expired leases still perform an authoritative probe for dead-process and PID-reuse decisions, and an unavailable probe preserves the existing gate. The lease parser remains compatible with records that already carry `processIdentity`.
