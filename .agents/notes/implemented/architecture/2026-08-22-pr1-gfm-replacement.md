# PR1 guardrail replacement

- The pull-request scope job runs for opened, synchronize, reopened, and edited events so body edits receive a fresh size decision.
- The existing size gate reports actual counts against the 10-file and 500-line target, requires a non-empty non-template `## Split rationale` when that target is exceeded, and retains hard caps of 40 files and 2,000 lines.
- Rationale extraction uses a small GFM visibility state machine: only 0-to-3-space headings and fences are structural, indented code and fenced or commented templates cannot authorize a change, and unclosed comments or fences fail closed. Runtime recovery, Governor state, review records, target workflows, and self-target mappings remain out of scope.
