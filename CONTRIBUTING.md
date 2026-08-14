# Contributing

Thank you for improving the agent automation controller. Keep changes small, reviewable, and independent of any model-provider credential.

## Development requirements

- Node.js 22 or newer is required for controller tests.
- PowerShell 7 and Windows are required for operations and bootstrap tests.
- Pin every third-party Action and every reusable controller call to a reviewed full commit SHA.
- Keep target repositories thin. Agent-specific paths and credentials belong only in the machine-local configuration.
- Never commit GitHub tokens, runner registration tokens, model keys, local configuration, PID records, manifests, or runner work directories.

## Before opening a pull request

Run the checks that cover the changed surface:

```powershell
npm test
pwsh -NoProfile -File scripts/test-operations.ps1
pwsh -NoProfile -File scripts/test-bootstrap-repository.ps1
```

Document any check that could not be run. A pull request that changes trust, provenance, process ownership, landing, recovery, or removal must include a rejecting test for the unsafe case. GitHub-facing text and commit history use English.

## Compatibility and safety

Configuration and workflow changes must fail closed when identity, repository, revision, process ownership, or expected permissions cannot be proven. Do not add scheduled model polling. Preserve the independent `change` and `review` queues and their separate stop controls.
