# PR4-B multi-scope capacity probes

- The runtime Worker router now leaves expired applicable capacity scopes eligible during planning, then asks the durable registry to claim every expired scope for the candidate under one registry lock after the immutable attempt claim.
- Probe leases bind the trusted Worker snapshot, capacity group, scope, and identity. A successful invocation completes every claimed scope; a verified pre-session capacity failure updates only its matching scope and abandons the rest; every other exit abandons all leases.
- The registry publishes no records when a multi-scope claim cannot acquire every due scope, and concurrent attempts observe the single shared lease before any second Worker invocation.
- Scope records retain only the identity fields owned by that scope; capacity-group records therefore remain reusable across Workers in the same stable group while lease and attempt ownership stays execution-specific.
- Expired half-open leases are due probes and may be reclaimed atomically; a trusted authoritative failure for a scope not in the probe claim is projected into that scope in the same transaction while every non-matching lease is abandoned.
