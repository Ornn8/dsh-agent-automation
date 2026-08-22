# Versioned Agent verification receipt

Completed Agent automation results now have a strict v2 form with one exact revision, one existing Verification Contract identity, its selected procedure or entrypoint, a passed result, and bounded unique evidence identifiers.

The pure binding helper checks the exact revision, contract identity, selected execution identity, and required evidence coverage without GitHub, Worker, Adapter, or filesystem access.

Version 1 completed and blocked results remain valid as an explicit finite migration input. This slice does not enforce v2 in Worker, CI, review, or landing paths.
