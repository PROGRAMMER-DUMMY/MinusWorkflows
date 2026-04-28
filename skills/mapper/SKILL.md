---
name: mapper
description: Manages the codebase dependency graph and performs blast-radius analysis. Use to identify context requirements and affected components.
---

## Phase: Mapping
Build and query a structural map of the codebase using portable execution.

1. **Build/Update**: Initialize or refresh the graph. 
   - Preferred: `uvx code-review-graph build`
   - Fallback: `code-review-graph build`
2. **Impact Analysis**: Analyze "blast radius".
   - Preferred: `uvx code-review-graph detect-changes --base HEAD~1`
4. **Visualize**: Generate D3.js architecture map.
   - Command: `uvx code-review-graph visualize`
5. **Snapshot**: Export current structural state as a versioned JSON delta.
   - Command: `uvx code-review-graph status --json` (Used by Evolve)


**Note**: If `uvx` is not found, the agent should attempt to install `uv` or use the local `pip` installation.

**Output**: A `.code-review-graph/` directory containing the graph database and structural insights.
