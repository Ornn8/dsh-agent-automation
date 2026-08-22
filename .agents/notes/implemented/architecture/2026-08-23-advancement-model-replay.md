# Advancement event-order model replay

The advancement policy and runtime now have a pure replay harness covering CI-first and review-first completion, duplicate wakes, one lost direct wake recovered by scheduled reconciliation, and stale delayed review evidence.

The harness asserts one effective landing request for a healthy exact pair, declared wake metadata for every observed wait, no scheduled dependency when direct wakes arrive, and no landing or repair effect for stale evidence. It changes no production behavior or workflow.
