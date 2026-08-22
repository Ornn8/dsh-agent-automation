# PR1 contribution guardrail

- The existing pull-request scope job now reports actual changed files and lines against a default target of 10 files and 500 changed lines, while retaining absolute caps of 40 files and 2,000 changed lines.
- Exceeding either default target requires a non-empty, non-template `## Split rationale` section in the pull-request body; the absolute caps remain hard rejection limits even with rationale.
- This slice changes only the existing size checker, its CI input, and focused tests; runtime recovery, Governor state, review records, architecture stops, target workflows, and self-target mappings remain out of scope.
