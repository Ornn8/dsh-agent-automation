# Bounded v3 Issue task declarations

`agent-work:v3` is the authoring form for one executable child Issue. The parser requires non-empty Objective, Scope, and Acceptance criteria sections, a positive parent, an abstract task class, and unique positive dependencies. It preserves the existing Profile and branch defaults, rejects mixed or duplicate recognized markers, and validates self references when the executable Issue number is available.

Valid `agent-work:v2` declarations remain supported and normalize to the abstract `default` task class. The normalized declaration is part of the existing request identity, so changing the parent, task class, dependency set, or another declaration field creates a new request identity. No scheduler, Worker selection, Operations capacity, or runtime dispatch behavior changes in this slice.
