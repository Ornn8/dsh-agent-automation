# Canonical routing lock and deferred review receipt

Local Worker routing records use the existing fenced capacity-registry lease instead of a record-specific lock file. The lease carries process identity and fencing, so a crashed owner can be reclaimed without treating an active or PID-reused process as stale. The routing record remains an atomic temporary-file publish under that lease.

An all-preclosed routing generation claims and journals each candidate before returning capacity-deferred. A same-generation replay returns a no-op receipt before review CheckRun creation. The first real deferred review publishes exactly one neutral exact-head CheckRun; it does not publish a verdict, repair, fault, or Governor budget update.
