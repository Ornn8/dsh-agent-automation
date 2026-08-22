# Trusted pull request size policy execution

- Decision: move the pull request size decision to a dedicated `pull_request_target` workflow with `contents: read`, and execute the locked policy from the exact pull request base commit.
- Trust model: the base checkout is the only source of Node policy, package metadata, and the guardrail script. The head checkout is isolated in a second directory and is used only as a Git object repository for the measured base/head diff; no head file, action, package, or configuration is executed.
- The workflow passes the event body only as data and passes the event base/head SHAs to the trusted script. The script continues to validate lowercase full SHAs before measuring the diff. The existing GFM parser, 10/500 target, 40/2,000 caps, and edited-body behavior remain unchanged.
- The former `controller-ci` pull request scope job is removed so its candidate-owned check cannot collide with the stable `trusted pull request size` check. After the first merge, repository administrators must add the new check name to branch protection required checks; that settings rollout is intentionally outside this PR.
- Consequence: controller tests remain in `controller-ci` for normal `pull_request` runs, while policy execution is isolated from candidate-controlled code. No repository settings, secrets, services, schedulers, databases, or runtime paths change.
