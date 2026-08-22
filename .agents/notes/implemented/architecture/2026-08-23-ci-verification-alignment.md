# CI verification contract alignment

Configured target CI check contexts now match the required checks in the trusted Verification Contract before pull-request advancement and landing. Unconfigured Profiles keep the existing behavior. Controller CI is pull-request-only, so a push event cannot duplicate the same-head pull-request run.
