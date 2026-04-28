# minusWorkflows Quickstart

**Software engineering minus the overhead.**

This guide will help you install and orchestrate your project using the `minusWorkflows` swarm.

---

## 1. Installation

Inject the stack into your project root:

```bash
# Using Node.js (Windows/macOS/Linux)
node C:/path/to/MinusWorkflows/install.js

# Using Bash (macOS/Linux)
bash C:/path/to/MinusWorkflows/install.sh
```

---

## 2. The Core Command: `minus`

The `minus` skill is your master orchestrator. It handles the entire lifecycle automatically.

**Usage:**
> "Gemini, minus: [Your Feature Request or Bug Report]"

**What happens next:**
1. **Mapper Sync**: Structural map updated via `uvx code-review-graph`.
2. **Architecture**: Design grilling and PRD generation.
3. **Planning**: Dependency analysis and `TASKS.json` creation.
4. **Swarm Execution**: Parallel sub-agents spawn on isolated git branches.
5. **Audit & Merge**: Automatic verification before merging into your feature branch.
6. **Evolution**: Lessons learned are saved to `.memory/EVOLUTION.md`.

---

## 3. Minustoken Protocol (Density Control)

Manage how much the AI talks to save tokens and speed up execution.

- **`/mt L1` (Full Fidelity)**: Bullet points, grammar. Best for Audits/Design.
- **`/mt L2` (Telegraphic)**: Dropped articles, abbreviations. Default mode.
- **`/mt L3` (Keywords)**: High-speed status updates only.
- **`/mt L4` (Code-Only)**: Zero prose. Maximum token budget for logic.

---

## 4. Self-Healing & Safety

- **Failure Escalation**: If a task fails 3 times, it is moved to `.vault/sandbox/failed_[id]` for your review. Your source code remains clean.
- **Hybrid Guardrails**: Dangerous commands like `rm -rf` or `git reset --hard` automatically trigger a high-fidelity (L1) safety explanation.
- **Evolving Intelligence**: Set `ALLOW_EVOLVING_GUARDRAILS: true` in `CONTEXT.md` to let the AI learn project-specific safety rules over time.

---

## 5. Local Intelligence (The Memory Vault)

- **`.memory/`**: Permanent record of decisions, roadmap, and evolution.
- **`.vault/`**: Secure sandbox for experimental code and immutable backups.
- **`CONTEXT.md`**: The foundational "Truth" file for your project.

---

**Built for AI-Native Engineers.**
No more manual context management. Just build.
