---
name: enforcer
description: Active context engineering tool that prunes the session window to minimize token bloat.
---

## Phase: Context Engineering
Manage the agent's memory window with surgical aggression.

1. **Skill Unloading**: Once a phase (Architect/Planner/Builder) is marked `Done`, explicitly instruct the agent to "Forget/Unload" those specific instructions.
2. **File Pruning**: Close or unload file contents that are not relevant to the current active Task ID.
3. **Density Management**: Monitor token usage. If the window exceeds 70% capacity, force a **Tier L3/L4** compression and a summary node.

**Goal**: Maintain 100% focus on the current sub-task while keeping costs low.
