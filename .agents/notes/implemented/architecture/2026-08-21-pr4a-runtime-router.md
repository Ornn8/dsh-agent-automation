# PR4-A runtime routing

- `runRoleWorker()` is an unintegrated runtime seam over the existing single-Worker primitive.
- `createWorkerExecutionClaim()` returns a process-local opaque admission token; the provider supplies the trusted capacity generation and must expose atomic `claimAttempt()`.
- Local routing derives and validates the worker-neutral decision from the WorkRequest and exact subject state; caller-supplied generation values are rejected.
- Durable attempt claims bind route policy, task class, Worker, and one capacity-group generation; replay returns before a Worker starts.
- Only authoritative capacity-group failures from the pre-session phase may continue; an `onStarted` callback makes the original failure terminal.
- Multi-scope probing, Controller payload authority, CheckRun mutation, repair, and resume remain out of scope.
