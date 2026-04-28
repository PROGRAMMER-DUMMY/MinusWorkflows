---
name: planner
description: Bridges the PRD to implementation by generating a dependency-aware roadmap. Use after the Architect phase.
---

## Phase: Planning
Transform the high-level PRD into a surgical execution graph.

0. **Step 0: Structural Sync**: Activate `minustoken L2`. Run `uvx code-review-graph update`.
1. **Dependency Analysis**: Use the graph to identify which components are downstream and must be built first.
2. **Deepening Discovery**: Identify "Architectural Debt" (e.g., tight coupling, missing abstractions) that should be refactored alongside the new feature.
3. **Roadmap Scaffolding**: Create a sequence of "Tracer Bullets" (vertical slices).
3. **Context Requirements**: List exactly which files and skills will be needed for each step.
4. **Phase 4: Cleanup**: Activate `evolve`. Activate `enforcer`. Prep for Implementation.

**Output**: 
- `.memory/ROADMAP.md`: Human-readable task graph.
- `.memory/TASKS.json`: Machine-readable dependency tree for parallel sub-agents.
