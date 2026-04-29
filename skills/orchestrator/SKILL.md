---
name: orchestrator
description: The Dynamic Agent Orchestrator. Selects the optimal topology (Parallel, Hierarchical, or Serial) and manages tool scoping for sub-agents.
---

## Phase: Topology Selection
Determine the execution strategy for the task graph defined in `TASKS.json`.

1.  **Selection Logic**:
    - **Parallel**: If tasks have 0 shared file dependencies and 0 logic dependencies.
    - **Hierarchical**: If tasks share state or require a Supervisor to maintain context across multiple Workers.
    - **Serial**: If the user provides `--serial` or if the task is deemed high-risk (e.g., modifying core infrastructure).

2.  **Manual Override**:
    - Obey user-provided flags (`--parallel`, `--serial`, `--hierarchical`) as the highest priority.

## Phase: Intelligence Routing (Dynamic Model Control)
Select the optimal model tier for each task using the `control-pane` skill.

1.  **Tier Selection**:
    - For each task, query `control-pane` with metadata (`type`, `risk`, `complexity`).
    - If `failure_count` > 0, apply escalation logic:
        - 2+ failures: Escalate `model_tier` (Flash -> Pro -> Ultra).
    - Map the selected tier to the corresponding model endpoint (e.g., `Ultra` -> `gemini-1.5-pro`).

2.  **State Tracking**:
    - Update `TASKS.json` with the current `model_tier` and `failure_count` for each task.

## Phase: Tool Scoping (The Tool Scalpel)
Restrict sub-agent capabilities based on their role in the topology to prevent context bloat and ensure surgical edits.

1.  **Enforcement Protocol**:
    - Before `invoke_agent`, the Orchestrator MUST inject a `tool_filter` instruction into the sub-agent's prompt.
    - **Supervisor/Root**:
        - **Access**: Full toolset (Standard + Administrative).
        - **Context Management**: Responsible for high-level plan and state sync.
        - **Token Budget**: 100% capacity.
    - **Worker (Parallel/Hierarchical Branch)**:
        - **Allowed (Surgical)**: `replace`, `read_file`, `grep_search`, `glob`.
        - **Restricted (Write-Heavy)**: `write_file` (allowed only for NEW files, blocked for existing).
        - **Blocked (System-wide)**: `run_shell_command` (unless whitelisted for specific build commands), `invoke_agent` (to prevent infinite nesting).
        - **Token Budget**: Max 40% capacity. Use `enforcer` to prune history after every 3 turns.

## Phase: Resilient Fallback (Collapse & Escalate)
Monitor the swarm and automatically apply corrective measures if errors occur.

1.  **Detection**: If a task fails its `auditor` check or a parallel branch fails 3+ consecutive checks.
2.  **Action 1: Intelligence Escalation**:
    - Increment `failure_count` for the task in `TASKS.json`.
    - If `failure_count` == 2, trigger `control-pane` to upgrade the `model_tier`.
3.  **Action 2: Topology Collapse**:
    - If escalation doesn't resolve the issue or for severe errors (`RateLimitError`):
        - **Suspend**: Immediately stop all active `invoke_agent` calls in the failing branch.
        - **Collapse**: Move the task from a **Parallel** worker to a **Serial** execution queue handled directly by the **Root** agent.
        - **Root Triage**: The Root agent takes over the file context, diagnoses the failure, and applies the fix.
4.  **Logging**: Document the escalation/collapse event in `.memory/sessions/[session_id]/[query_id]/LOGS.md` and update `.memory/sessions/[session_id]/[query_id]/TASKS.json`.
