---
name: discovery
description: Scans the codebase for architectural patterns, technical debt, and deepening opportunities to inform design recommendations.
---

## Phase: Proactive Discovery
Analyze the current state of the codebase before design decisions are finalized.

1.  **Pattern Recognition**:
    - Identify repetitive boilerplate.
    - Find tightly coupled modules via `mapper`.
    - Detect "God Objects" or oversized files (>500 lines).

2.  **Debt Detection**:
    - Look for "TODO" or "FIXME" comments in the affected scope.
    - Check for missing type safety or undocumented interfaces.

3.  **Opportunity Mapping**:
    - Suggest where a new abstraction (Factory, Strategy, Wrapper) would simplify the code.
    - Identify where parallelization or model-tier optimization (via `control-pane`) could be applied.

**Output**: A concise "Discovery Report" used by `grill-me` to provide expert recommendations.
