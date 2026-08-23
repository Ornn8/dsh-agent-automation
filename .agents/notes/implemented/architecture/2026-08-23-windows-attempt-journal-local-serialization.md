# Windows attempt-journal mutation serialization

## Problem

Concurrent attempt-journal mutations from one Node process were all polling the durable registry lease. On Windows, the resulting filesystem contention could leave the existing 68-writer and four-reader compaction test running for more than its 60-second bound under full-suite load.

## Decision

Append and claim mutations now share a process-local queue per state root before entering the durable lease. The durable lease remains the cross-process authority, and the generic lock API is unchanged. The existing concurrent attempt-journal regression remains the proof seam: it starts 68 append writers and four readers, asserts monotonic reads and all 69 retained attempts, and verifies immutable compaction without relying on a timing assertion.

## Consequences

Same-process journal callers no longer self-contend on the filesystem gate; independent processes continue to use the durable lease. This changes no journal format, fencing rule, retry policy, or cross-process ownership behavior.
