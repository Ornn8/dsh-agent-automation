# Review WorkRequest verification-contract binding

Review Workers now use the trusted Profile Verification Contract when creating their Stage WorkRequest. The generated request ID is shared by durable execution and the fixed review workspace lease, so changing the contract cannot replay a completed review from an earlier contract identity.

The full loaded contract and hash are review criteria and observation context only. They do not authorize a verdict, suppress findings, or replace exact-head CI evidence. Unconfigured Profiles keep the prior review behavior.
