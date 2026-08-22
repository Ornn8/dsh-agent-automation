# v2 dependency graphs fail closed before dispatch

## Problem

Backlog selection treated an absent dependency as satisfied and only waited on open Issue numbers, so self references, cycles, and pull-request references were not rejected before dispatch.

## Decision

Build one deterministic dependency result from the current state=all Issue snapshot plus open pull-request numbers before selecting v2 Issue work. Closed Issues satisfy dependencies; open Issues wait; missing Issues, pull requests, self references, cycles, invalid states, and conflicting snapshots produce bounded diagnostics. Apply the result to requested single selection and ordinary bounded batch selection while preserving independent ready Issues.

## Consequences

Invalid candidates are skipped before Governor/Worker dispatch and the backlog dispatcher exposes at most 64 JSON diagnostics. No GitHub schema or API changes are required; v3, taskClass, parallel execution, Planner, Operations, and workflow behavior remain unchanged.
