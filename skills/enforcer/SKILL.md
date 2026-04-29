---
name: enforcer
description: Active context engineering tool that prunes the session window to minimize token bloat.
---

## Phase: Context Engineering & Safety
Manage the agent's memory window and enforce security guardrails.

**Config**:
- `ALLOW_EVOLVING_GUARDRAILS`: [true/false] (Defined in `CONTEXT.md`. Default: true)

1. **Safety Buffer (Hybrid)**:
   - **Rules-Based (Forbidden)**: 
     - `git push --force`
     - `git reset --hard` (unless on a `minus/` branch)
     - `git clean -fd`
     - `rm -rf` (on root or source directories)
     - `npm/pip uninstall` for core dependencies.
   - **Intent-Based**: Before executing "Mass Refactors" (touching >3 files), force **Tier L1** for a structural impact summary.
2. **Snapshot Retrieval (Linear History)**:
   - When a task starts, identify modified files/modules.
   - Load only the JSON snapshots from `.memory/sessions/[session_id]/[query_id]/snapshots/` that contain structural changes relevant to those modules.3. **Skill Unloading**: Once a phase is marked `Done`, explicitly "Unload" those instructions.
2. **File Pruning**: Close or unload file contents that are not relevant to the current active Task ID.
3. **Density Management**: Monitor token usage. If the window exceeds 70% capacity, force a **Tier L3/L4** compression and a summary node.

**Goal**: Maintain 100% focus on the current sub-task while keeping costs low.
