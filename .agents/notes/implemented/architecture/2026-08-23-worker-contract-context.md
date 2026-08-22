# Worker verification-contract context

Issue and transported repair Worker Skill payloads now carry the already-loaded trusted Profile Verification Contract when one is configured.

Unconfigured Profiles omit the field. Repair paths do not reread candidate content; this change only transports context already loaded by the existing trusted Profile path and does not enforce receipts or alter Worker postconditions.
