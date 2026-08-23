# Optional repository supervision upstream

Repository bootstrap renders `agent-repository-supervision.yml` only when `UpstreamRepository` names a real upstream. Omitting the upstream excludes supervision from a fresh target and, with explicit `-Update`, removes the previously generated workflow; a local edit fails closed without `-Update`. Configured-upstream rendering remains unchanged.
