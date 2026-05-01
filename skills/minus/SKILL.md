---
name: minus
description: The Master Orchestrator. Executes the entire project lifecycle (Architect -> Planner -> Builder -> Evolve) with parallel sub-agent support.
---

## Phase: Orchestration (Master Swarm)
Coordinate multiple sub-agents to deliver a complex feature in parallel.

0.  **Intent Classification & Triage (New)**:
    - **Document Ingestion**: If the user provides a file path (e.g., a Markdown document, a Jira export), use `read_file` to analyze its completeness.
        - *Rough Idea / Incomplete*: Route to `architect` to grill the user and finalize the PRD.
        - *Bug Report / Stack Trace*: Route to `maintainer` and `diagnose`.
        - *Complete Actionable PRD*: Bypass `architect` entirely and route directly to `planner`.
    - **Fast-Track**: If the user request is just text (no file) and is a simple fix or isolated change, **BYPASS** the heavy `architect` and `planner` phases. Route directly to `maintainer`.
    - **CRITICAL**: Even for fast-tracked tasks or pre-planned documents, you MUST jump to **Phase 8: Final Evolution** (`evolve`) once complete, ensuring the outcome is logged in `.memory/EVOLUTION.md`.
    - For all other standard complex requests, proceed to step 1.

1.  **Architecture & Planning**:
    - Activate `architect` then `planner`.
    - Output: A dependency-aware `TASKS.json` tree with topology tags.
2.  **Orchestration Logic**:
    - **Activate `orchestrator`**: Analyze `TASKS.json` and confirm the execution strategy.
    - **Tool Scoping**: The Orchestrator applies the "Tool Scalpel" to restricted worker branches.
3.  **Swarm Execution**:
    - Spawn sub-agents (via `invoke_agent`) based on the tagged topology (Parallel/Hierarchical).
    - **Monitor**: Update `.memory/sessions/[session_id]/[query_id]/LOGS.md` with real-time agent heartbeats.
4.  **Resilience**:
    - If an agent fails, the Orchestrator triggers a "Topology Collapse" to Serial mode.
5.  **Conflict Management**:
    - For `connected` or `nested` tasks, use a serial queue to prevent branch collisions.
6. **Verification & Merge**:
    - Run the `auditor` and `vault-harness` to verify all parallel branches before merging.
7. **Failure Escalation**:
    - If a sub-agent fails its audit > 3 times:
      1. **Kill & Revert**: Stop the agent and revert the sub-branch to maintain a clean feature base.
      2. **Sandbox Triage**: Move failing code and logs to `.vault/sandbox/failed_[task_id]/`.
      3. **Escalate**: Present a "Diagnostic Report" to the user and wait for human intervention.
8. **Final Evolution**:
    - Run `evolve` to capture lessons learned across all agents.


**Command**: `Gemini, minus: [instruction]`
