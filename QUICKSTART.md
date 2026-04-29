# minusWorkflows — Quickstart

Get from zero to a running swarm in under 10 minutes.

---

## Prerequisites

- **Gemini CLI** installed and authenticated
- **uv** for portable Python tool execution

```bash
# Install uv (if missing)
curl -LsSf https://astral.sh/uv/install.sh | sh
```

---

## Step 1 — Install into Your Project

```bash
# Clone minusWorkflows once (wherever you keep tools)
git clone https://github.com/YOUR_USERNAME/minusWorkflows.git ~/tools/minusWorkflows

# Navigate to your project
cd /path/to/your-project

# Inject the skill stack
node ~/tools/minusWorkflows/install.js
```

This creates `.memory/`, `.vault/`, and `.code-review-graph/` and registers the skills with Gemini CLI.

---

## Step 2 — Bootstrap the Dependency Graph

Before the first run, give the Mapper a baseline:

```bash
uvx code-review-graph build
```

This scans your codebase and writes a SQLite graph to `.code-review-graph/graph.db`. Re-run after large refactors.

---

## Step 3 — Your First Command

For a complex feature, use the Master Orchestrator:

```
Gemini, minus: add a rate-limiting layer to the /api/v2 endpoints
```

The system walks through all five phases automatically:

1. **Architect** — grills you on design decisions one at a time, writes the PRD
2. **Planner** — builds a dependency graph, outputs `TASKS.json`
3. **Swarm** — spawns parallel sub-agents on isolated branches
4. **Audit** — validates each branch against the PRD before merge
5. **Evolve** — logs what worked and what failed for next time

---

## Step 4 — Targeted Workflows

You don't always need the full pipeline. Use individual phases:

### Design only (no code yet)
```
Gemini, architect: a webhook delivery system with retry logic
```

### Implement from an existing PRD
```
Gemini, builder: .memory/sessions/[session_id]/[query_id]/PRD_webhook_delivery.md
```

### Fix a bug
```
Gemini, maintainer: the /checkout endpoint returns 500 on free-tier users
```

### Debug a hard problem
```
diagnose: payment webhook signature validation fails intermittently
```

---

## Step 5 — Control Token Density

Switch tiers mid-session to manage cost and speed:

| Command | Mode | Use when |
| :--- | :--- | :--- |
| `/mt L1` | Full fidelity | Designing, auditing |
| `/mt L2` | Telegraphic (default) | Normal development |
| `/mt L3` | Keywords only | Status checks |
| `/mt L4` | Code + paths only | Heavy implementation |

---

## Step 6 — Check What the System Learned

After any session, review the evolution log:

```bash
cat .memory/EVOLUTION.md
```

Each entry follows: **Scenario → Failure → Fallback**. Next time the AI hits the same scenario, it skips to the validated fallback automatically.

---

## Key Files

| File | Purpose |
| :--- | :--- |
| `.memory/CONTEXT.md` | Domain language and architectural mandates. Set hard constraints here. |
| `.memory/EVOLUTION.md` | Accumulated Scenario → Failure → Fallback patterns |
| `.memory/sessions/[session_id]/[query_id]/TASKS.json` | Current task dependency tree (machine-readable) |
| `.memory/sessions/[session_id]/[query_id]/ROADMAP.md` | Current task dependency tree (human-readable) |
| `.vault/INDEX.md` | Map of all golden-state backups and snapshots |
| `.code-review-graph/graph.db` | SQLite structural dependency graph |

---

## Failure Recovery

If a sub-agent fails its audit three times, the system automatically:
1. Kills and reverts the failing branch
2. Moves logs to `.vault/sandbox/failed_[task_id]/`
3. Surfaces a Diagnostic Report and waits for your input

You can also trigger manual diagnosis at any time:
```
diagnose: [description of the failure]
```

---

## Visualize the Architecture

```bash
uvx code-review-graph visualize
```

Opens a D3.js graph in your browser showing the full dependency structure of your codebase.

---

## Next Steps

- Edit `.memory/CONTEXT.md` to define domain vocabulary and non-negotiable constraints
- Review `skills/minus/SKILL.md` to see exactly what the orchestrator does at each phase
- Run `uvx code-review-graph status --json` to inspect the current structural snapshot
