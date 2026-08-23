# Runner watchdog maintenance window

The hosted runner watchdog now derives a 60-minute maintenance and readiness freshness window from four nominal 15-minute schedule intervals. This absorbs GitHub schedule and workflow-promotion jitter observed between successful readiness runs without adding state, services, or configuration. The queued Agent and Controller workflow stale threshold remains a separate 20-minute rule.

The pure freshness helper accepts an injected current time so the observed three-interval gap and the four-interval expiry are regression-tested without network or workflow execution.
