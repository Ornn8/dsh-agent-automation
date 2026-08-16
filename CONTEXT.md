# Agent Automation Control Plane

This context defines the trusted orchestration language shared by controllers and independently queued Agent Workers. Project procedures remain configuration supplied through a Profile rather than behavior owned by the control plane.

## Language

**Workflow Definition**:
A trusted, versioned Profile document that declares named Stage graphs and generic coordination settings. It references registered Adapter kinds without defining project implementation procedures.
_Avoid_: Pipeline configuration, recipe

**Profile**:
A named, reusable collection of workflows identified by `profileId`. A Profile may provide the installed default or replace it for a target repository without changing the orchestration Module.
_Avoid_: Preset, template

**Stage**:
One node in a workflow dependency graph that selects a registered Adapter and supplies that Adapter's configuration. Stage dependencies define execution order; the Stage does not contain executable code.
_Avoid_: Step, job

**WorkRequest**:
An immutable request binding one subject revision to one Workflow Definition and Stage. It is the durable Seam between the Governor and a Worker Adapter.
_Avoid_: Agent command, prompt

**Governor**:
The Module that admits, budgets, pauses, resumes, and records WorkRequest transitions. Labels and comments may project Governor state but do not replace its authority.
_Avoid_: Scheduler, label state

**Maintenance Profile**:
The trusted Controller-owned document that declares deterministic recovery, maintenance procedure, allowed repair paths, independent review, checks, promotion, verification, resume behavior, backoff, and fixed circuit limits.
_Avoid_: Recovery prompt, emergency mode

**FaultRecord**:
The append-only trusted state of one root infrastructure fault. It binds affected WorkRequests, meaningful state version, epochs, finite attempts, one repair pull request, one release, verification, and circuit status. Its GitHub Issue is only a projection.
_Avoid_: Fault Issue, retry comment

**Role Process Host**:
The Windows Operations process that accepts a fixed executable specification and owns the private desktop, bounded logs, timeout, cancellation, and kill-on-close Job Object for the complete descendant tree. Agent Adapters do not implement these host concerns.
_Avoid_: Agent launcher, Codex window hider
