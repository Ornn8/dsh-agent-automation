# PR5 capacity-wait identity

The inert capacity-wait projection preserves the WorkRequest v2 repository and coordination key in addition to its existing identity fields. Resume identity hashes the complete projection and route decision, while selection requires the saved repository to match the exact current open subject.
