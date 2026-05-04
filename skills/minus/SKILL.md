---
name: minus
description: The Master Orchestrator. Executes the entire project lifecycle (Architect -> Planner -> Builder -> Evolve) with parallel sub-agent support.
version: 1.1.0
---

## Phase: Orchestration (Master Swarm)
Coordinate multiple sub-agents to deliver a complex feature in parallel.

-1. **Graph Sync (best-effort)**:
    - Try `uvx code-review-graph update` (or `code-review-graph update` if uvx is unavailable).
    - If the command fails or is not installed, log a warning and continue — never block on this.
    - The system uses `git log` and the current working tree as authoritative fallback context.

0.  **Intent Classification & Triage (New)**:
    - **Document Ingestion (Full Exploration)**: If the user provides a file path (e.g., a Markdown document, a Jira export), you MUST use `read_file` to ingest it entirely. If the file is truncated, you MUST make subsequent `read_file` calls (using `start_line`) to read the complete document. You must fully scan and extract all architectural findings, constraints, and dependencies before deciding.
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
    - Spawn sub-agents via `pipeline_executor.run(goal, phases)` (see `utils/pipeline_executor.js`).
    - Each phase must emit a `PhaseReceipt` JSON block; the executor validates it before unlocking the next phase.
    - **Monitor**: Phase state is persisted to `.memory/sessions/{session_id}/state.json`; receipts written to `receipts/{phase}.json`.
4.  **Resilience**:
    - Failed phases are auto-retried up to `PIPELINE_RETRY_LIMIT` (default 3) with the prior receipt's failure context injected into the next prompt.
    - If retries are exhausted, the executor writes `DIAGNOSTIC.md` and halts — the pipeline never silently skips a broken phase.
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


**Invocation**:
- Claude Code → `/minus [goal]`
- Gemini CLI  → `Gemini, minus: [goal]`
- Any provider → activate this skill and pass your goal as the argument

**Session recovery commands**:
- `/resume [session_id]` — continue a halted session from the failed phase
- `/retry [session_id]` — same as resume but prompts for a human recovery hint first
- `/abandon [session_id]` — discard a halted session and start fresh

Session files: `.memory/sessions/{session_id}/state.json` (machine state) · `receipts/` (validated phase outputs) · `DIAGNOSTIC.md` (failure report)
