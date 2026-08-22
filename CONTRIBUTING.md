# Contributing

Thank you for improving the agent automation controller. Keep changes small, reviewable, and independent of any model-provider credential.

## Development requirements

- Node.js 22 or newer is required for controller tests.
- PowerShell 7 and Windows are required for operations and bootstrap tests.
- Pin every third-party Action and every reusable controller call to a reviewed full commit SHA.
- Keep target repositories thin. Agent-specific paths and credentials belong only in the machine-local configuration.
- Never commit GitHub tokens, runner registration tokens, model keys, local configuration, PID records, manifests, or runner work directories.

## Bounded change cycle

Controller development is ordinary manual repository development. Do not enroll this repository as a product target or add a self-targeting repository mapping.

For each pull request, implement one minimum coherent change, freeze its exact base/head pair, and run one ordinary senior review. Persist the terminal review verdict in GitHub before closing or merging, including the exact base/head pair and reviewer identity. PASS, BLOCK, and UNAVAILABLE are terminal for that exact cycle; progress messages are not review evidence. A changed head invalidates the verdict, while task termination or context loss must not erase the recorded result.

After BLOCK or UNAVAILABLE, do not automatically edit code or start another review. An explicit operator decision is required. A second architectural mechanism pivot or a repeated failure family with the same common repair closes or supersedes the current pull request and restarts the work as a smaller design slice.

Keep tests and documentation for a behavior change in the same pull request. Use existing GitHub state and contribution checks; do not add a Web service, database, scheduler, self-targeting mapping, or another polling loop to implement this cycle.

Keep one pull request focused on one lifecycle responsibility among routing, review, recovery, landing, and Operations. Target no more than 10 files and 500 changed lines; exceeding that target requires a written split rationale. More than 40 files or 2,000 added plus deleted lines is a hard rejection limit, and multi-lifecycle work must split regardless of size.

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
