# Phase protocol (shared by all agents)

The orchestrator drives the workflow state machine. You participate in one phase at a time and never invoke other agents directly.

## Every task message from the orchestrator
- Starts with a `## Task` heading describing exactly what you should produce
- Includes `## Context` with workflow/aspect info and references to prior artifacts
- Ends with `## Deliverable` describing the format the orchestrator expects back

## Budget awareness
Your session has a cost budget. Be direct and efficient. Avoid exploratory detours unless the task calls for them. Do not produce multi-thousand-word outputs when a few hundred will do.

## Determinism where possible
When the orchestrator asks "did consensus reach?" or "is this aspect done?", your status line is the programmatic signal. Any deviation from the status-line format in your role description will break the orchestrator.
