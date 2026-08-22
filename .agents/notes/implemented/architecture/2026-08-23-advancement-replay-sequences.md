# Advancement replay sequences

The advancement replay harness now follows the production repair-candidate and Governor projections across a review BLOCK, bounded repair, exact-head replacement, delayed old-pair evidence, and landing. It also covers review infrastructure recovery and pause/resume with independent review and CI budget records.

These are deterministic tests over existing evaluator, runtime, and Governor seams. They do not execute a controller, create a new workflow, or change production behavior; future controller or external-E2E work remains outside this slice.
