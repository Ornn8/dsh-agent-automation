# Security policy

## Supported versions

Until the first tagged release, only the current default branch receives security fixes. Immutable controller commits remain auditable pins, but users should migrate target workflows to a reviewed fixed commit when a security update is published.

## Reporting a vulnerability

Use GitHub private vulnerability reporting for this repository. Do not open a public Issue for suspected credential exposure, workflow-injection, provenance-bypass, process-ownership, or unsafe-removal vulnerabilities.

Include the affected controller commit, target event, expected trust decision, observed behavior, and a minimal reproduction without live credentials. Maintainers will acknowledge the report, validate impact, and coordinate a fix before public disclosure.

## Credential boundary

This repository does not accept model keys, GitHub tokens, runner registration tokens, or private machine configurations. Revoke and rotate a credential through its provider if it was exposed; deleting it from Git history is not sufficient.
