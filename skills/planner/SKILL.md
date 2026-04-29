---
name: planner
description: Bridges the PRD to implementation by generating a dependency-aware roadmap. Use after the Architect phase.
---

## Phase: Planning
Transform the high-level PRD into a surgical execution graph.

0. **Structural Sync**: Activate `minustoken L2`. ALWAYS RUN `uvx code-review-graph build` (or `update`) before planning to ensure the graph matches the current file state.
1. **Dependency Analysis**: Use the graph to identify which components are downstream and must be built first.
2. **Deepening Discovery**: Identify "Architectural Debt" (e.g., tight coupling, missing abstractions) that should be refactored alongside the new feature.     
3. **Topology Tagging**:
    - Analyze the `TASKS.json` graph for file overlaps and logical dependencies.
    - **Tag `Parallel`**: Tasks with 0 shared files and 0 dependencies.
    - **Tag `Hierarchical`**: Groups of tasks that share a common state or file but can be split into worker sub-tasks.
    - **Tag `Serial`**: High-risk tasks or those with strictly sequential logic.
4. **Roadmap Scaffolding**: Create a sequence of "Tracer Bullets" (vertical slices).
5. **Intelligence Routing Metadata**:
    - For each task in `TASKS.json`, assign:
        - `type`: "planning", "research", "implementation", "diagnosis", etc.
        - `risk`: "low", "medium", "high".
        - `complexity`: "low", "medium", "high".
    - These fields will be used by the `control-pane` for model tier selection.
6. **Context Requirements**: List exactly which files and skills will be needed for each step.
7. **Phase 7: Cleanup**: Activate `evolve`. Activate `enforcer`. Prep for Implementation.
**Output**: 
- `.memory/sessions/[session_id]/[query_id]/ROADMAP.md`: Human-readable task graph.
- `.memory/sessions/[session_id]/[query_id]/TASKS.json`: Machine-readable dependency tree with metadata (`type`, `risk`, `complexity`) for the Intelligence Router.
