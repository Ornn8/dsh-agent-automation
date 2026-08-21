# PR4-C2 change and repair routing

- Issue implementation and pull-request repair now create one controller-owned role execution claim and run through the bounded change routing pool. Concrete Worker, provider, model, and capacity identity remain machine-local and are not added to the WorkRequest.
- The claim binds the existing exact subject state and trusted task evidence, so the route class stays stable while capacity selection may move between admitted change Workers.
- Only a verified pre-session capacity failure or unavailable capacity defers to another candidate. A started Worker or any non-capacity failure remains terminal; no blind mid-session takeover is introduced.
- A capacity-deferred change or repair records a non-product `capacity-waiting` status and keeps the original WorkRequest eligible. A completed durable replay rechecks the existing postcondition without starting another Worker; other terminal replays fail closed.
- Repair routing reclassifies from bounded exact-head changed-file paths, trusted WorkRequest Stage, and verified repair cause on every run; mutable PR text, automation labels, and status comments are not routing authority.
- Capacity waiting removes the transient `automation/repairing` projection and is re-entrant only after the prior successful deferred run; terminal statuses remain closed.
