---
name: minus
description: The Master Orchestrator. Executes the entire project lifecycle (Architect -> Planner -> Builder -> Evolve) with parallel sub-agent support.
---

## Phase: Orchestration (Master Swarm)
Coordinate multiple sub-agents to deliver a complex feature in parallel.

1.  **Architecture & Planning**: 
    - Activate `architect` then `planner`. 
    - Output: A dependency-aware `TASKS.json` tree.
2.  **Swarm Execution**:
    - Identify `independent` tasks using the `code-review-graph`.
    - Spawn parallel sub-agents (via `invoke_agent`) for independent branches.
    - **Monitor**: Update `.memory/LOGS.md` with real-time agent heartbeats.
3.  **Conflict Management**:
    - For `connected` or `nested` tasks, use a serial queue to prevent branch collisions.
4. **Verification & Merge**:
    - Run the `auditor` and `vault-harness` to verify all parallel branches before merging.
5. **Failure Escalation**:
    - If a sub-agent fails its audit > 3 times:
      1. **Kill & Revert**: Stop the agent and revert the sub-branch to maintain a clean feature base.
      2. **Sandbox Triage**: Move failing code and logs to `.vault/sandbox/failed_[task_id]/`.
      3. **Escalate**: Present a "Diagnostic Report" to the user and wait for human intervention.
6. **Final Evolution**:
    - Run `evolve` to capture lessons learned across all agents.


**Command**: `Gemini, minus: [instruction]`
