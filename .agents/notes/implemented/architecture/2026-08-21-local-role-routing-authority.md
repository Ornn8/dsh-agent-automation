# Local role routing authority

Role execution derives `WorkerRouteDecision` from the machine-local routing policy, live WorkRequest, and trusted subject snapshot. Repository dispatch payloads carry the WorkRequest only; a transported route object is never an admission source.

The local routing record binds WorkRequest id, role, subject state, policy hash, and evidence hash. Its generation comes from the trusted Actions run identity when available or a durable local generation. Capacity attempt identity hashes the stable sorted vector of applicable scope identities, generations, and start states. Duplicate claims return a replay receipt before Worker, CheckRun, checkout, repair budget, or capacity projection work.
