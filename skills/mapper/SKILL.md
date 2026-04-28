---
name: mapper
description: Manages the codebase dependency graph and performs blast-radius analysis. Use to identify context requirements and affected components.
---

## Phase: Mapping
Build and query a structural map of the codebase to minimize token usage.

1. **Build/Update**: Initialize or refresh the local SQLite graph.
   - Command: `code-review-graph build` (Full) or `code-review-graph update` (Incremental)
2. **Impact Analysis**: Analyze the "blast radius" of recent changes compared to a git base.
   - Command: `code-review-graph detect-changes --base [branch/hash]`
3. **Background Sync**: Watch the filesystem and update the graph in real-time.
   - Command: `code-review-graph watch`
4. **Visualize**: Generate a D3.js visualization for structural auditing.
   - Command: `code-review-graph visualize`

**Output**: A `.code-review-graph/` directory containing the graph database and structural insights.
