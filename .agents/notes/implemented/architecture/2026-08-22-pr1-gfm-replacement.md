# PR1 guardrail replacement

- The pull-request scope job runs for opened, synchronize, reopened, and edited events so body edits receive a fresh size decision.
- The existing size gate reports actual counts against the 10-file and 500-line target, requires a non-empty non-template `## Split rationale` when that target is exceeded, and retains hard caps of 40 files and 2,000 lines.
- Rationale extraction replaces the former hand-written visibility state machine with the maintained `marked` GFM tokenizer and its nested tokens: only rendered level-two headings and visible text before the next same-or-higher heading can authorize a change; code and HTML tokens cannot, and unclosed comment/fence tokens fail closed. The scope job installs the locked parser dependency before running the gate. Runtime recovery, Governor state, review records, target workflows, and self-target mappings remain out of scope.
