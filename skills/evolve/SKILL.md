---
name: evolve
description: Reinforcement learning loop. Analyzes the current session to extract fallbacks and update project intelligence.
version: 1.0.0
---

## Phase: Self-Evolution
Analyze the session to refine the project's "Heuristics Tree."

1. **Scenario Analysis**: Identify the core technical challenges faced in this session.
2. **Failure Mapping**: Document any "Wrong Moves" (tool failures, incorrect assumptions, or dead-ends).
3. **Fallback Extraction**: Identify the specific path that eventually succeeded.
4. **Snapshot Generation**:
   - Run `uvx code-review-graph status --json` to capture the current structural state.
   - Save a versioned delta to `.memory/sessions/[session_id]/[query_id]/snapshots/v_[timestamp].json`.
5. **Knowledge Injection**: 
   - Update `.memory/EVOLUTION.md` with the new **Scenario -> Failure -> Fallback** pattern.
   - **If `ALLOW_EVOLVING_GUARDRAILS` is true**: Update the `enforcer` safety rules or `CONTEXT.md` with new project-specific constraints.

**Rules**:
- Use "Gradient Descent" logic: If a path failed, increase its "Risk Weight" in the evolution log.
- Prefer "Surgical Fallbacks" over "Brute Force" solutions.

**Goal**: Ensure the AI never makes the same mistake twice on this project.
