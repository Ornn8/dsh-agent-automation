# PR4-C review routing and capacity deferral

- The review Worker now receives an opaque controller-owned routing claim bound to the exact pull-request pair, trusted Profile definition, and review stage. Concrete Worker, provider, model, and route generation remain machine-local.
- One leased exact review workspace is retained while the runtime router attempts the bounded admitted review candidates. Only verified pre-session capacity failures may advance to another candidate; a started reviewer or any non-capacity failure remains terminal.
- Durable attempt claims return a merged terminal result when a prior Worker finished after its initial claim; capacity-only prior results continue bounded candidate scanning, while other replays remain terminal and fail closed.
- When every admitted candidate is unavailable, the controller completes one exact-head `agent/review` CheckRun with a neutral capacity-deferred conclusion. A capacity-deferred replay reuses that neutral CheckRun instead of creating another verdict-bearing CheckRun; a terminal Worker replay fails closed, and a later real review creates a fresh CheckRun so a neutral run cannot be upgraded into an unearned PASS or BLOCK.
- Review workspace cleanup remains in `finally`; the deferred path returns normally and does not terminate the process from inside the cleanup scope.
- Neutral capacity-deferred CheckRuns are reusable only within the same trusted GitHub Actions run and attempt; a later invocation always publishes its own v3 CheckRun.
- A completed Worker attempt durably retains its bounded machine output, allowing a replay after process interruption to publish the same review without starting another Worker or treating a non-capacity outcome as deferred.
