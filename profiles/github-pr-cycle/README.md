# GitHub pull request cycle

`github-pr-cycle` is the bundled baseline orchestration profile. Its `default` workflow runs one Issue change worker, one independent review worker, the repository's configured required checks, and an exact-revision merge in that order. Its `repair` workflow starts with the registered pull-request repair procedure and then rejoins the same review, checks, and merge sequence with a bounded retry schedule.

The profile intentionally contains no agent product, model, repository, credential, or runner selection. A deployment binds the abstract `change` and `review` roles to its own workers. The procedure names `github-issue-work` and `github-pr-review` select registered procedure implementations; a deployment can add another procedure through an Adapter without adding product branches to the Governor.

The checks Stage uses `source: "branch-protection"`, so the checks Adapter resolves the required checks from the target branch's trusted protection settings. The profile does not reserve a magic check name. A deployment may instead provide explicit check names in another trusted profile. The target repository also owns whether squash merge and branch deletion are appropriate.

The orchestration engine treats this file as data, not built-in policy. The Workflow Definition Module can represent a single worker, manual landing, human approval through a protected check, explicit external checks, different dependencies, or a different concurrency limit. The bundled GitHub PR cycle Adapter executes this four-Stage graph; a materially different graph needs a compatible lifecycle Adapter, but does not require a Governor change.
