# Quick Start — 5 Minutes to Running

Two paths. Pick the one that fits.

---

## Path A: Skills only (no Docker, instant)

Use the AI orchestration skills without the persistent memory service. Works immediately.

```bash
# 1. Clone
git clone <repo> MinusWorkflows && cd MinusWorkflows

# 2. Install skills into your AI CLI(s)
node install.js

# 3. Start using it
# In Claude Code:
/minus Build a REST API for user authentication

# In Gemini CLI:
Gemini, minus: Build a REST API for user authentication
```

That's it. Skills are installed into `~/.claude/commands/` (Claude Code) and/or `~/.gemini/skills/` (Gemini CLI) automatically.

---

## Path B: Skills + Memory service (recommended for teams)

Persistent episodic memory across sessions, with vector search, optical retrieval, and multi-tenant isolation.

```bash
# 1. Clone and run the setup wizard
git clone <repo> MinusWorkflows && cd MinusWorkflows
npm install
npm link          # makes `minus` available globally

# 2. Interactive setup (picks your provider, generates secrets, starts Docker)
minus init

# 3. Verify
minus status
```

Output of `minus status`:
```
Service health
  ✓  OCR-Memory        ok
  ✓  Database          ok
  ✓  Cache             ok (disk)
  ✓  Mode              lite

Provider config
  ✓  Agent provider    claude
  ✓  Model             claude-sonnet-4-6
  ✓  API_KEY           a1b2c3d4...
  ✓  ADMIN_KEY         e5f6g7h8...
```

---

## Your first skill run

```
/minus Implement a checkout flow with Stripe, tests included
```

The orchestrator runs each phase mechanically:

```
architect  → defines requirements + PRD
planner    → dependency-aware task graph
builder    → writes code, runs tests
auditor    → validates against requirements
evolve     → captures lessons to EVOLUTION.md
```

Each phase emits a `PhaseReceipt` JSON block. If a phase fails, it auto-retries (up to 3×) with failure context injected. After 3 failures it writes `DIAGNOSTIC.md` and halts — never silently skips a broken phase.

---

## Switch provider in one line

```bash
# Use Gemini CLI for sub-agents
echo "AGENT_CLI=gemini" >> .env
echo "AGENT_DEFAULT_MODEL=gemini-2.0-flash" >> .env

# Use Anthropic API directly (no CLI binary needed)
echo "AGENT_PROVIDER=http" >> .env
echo "AGENT_API_URL=https://api.anthropic.com/v1/messages" >> .env
echo "AGENT_API_KEY=sk-ant-..." >> .env
echo "AGENT_API_FORMAT=anthropic" >> .env

# Use OpenAI API
echo "AGENT_PROVIDER=http" >> .env
echo "AGENT_API_URL=https://api.openai.com/v1/chat/completions" >> .env
echo "AGENT_API_KEY=sk-..." >> .env
echo "AGENT_API_FORMAT=openai" >> .env

# Any OpenAI-compatible endpoint (Codex, Azure OpenAI, Ollama, etc.)
echo "AGENT_PROVIDER=http" >> .env
echo "AGENT_API_URL=https://your-endpoint/v1/chat/completions" >> .env
echo "AGENT_API_FORMAT=openai" >> .env
```

No restart needed — env vars are read at invocation time.

---

## Common commands

```bash
minus status                           # health check
minus store --project <uuid> "event 1" "event 2"
minus retrieve --project <uuid> --query "what happened during checkout"
minus keys create --label "team-alpha" --expires-in-days 90
minus keys list
minus retention                        # clean up old episodes
minus benchmark                        # run full test harness
```

---

## Verify with the test harness

```bash
minus benchmark
```

Expected output when all services are running:

```
MinusWorkflows Test Harness
Target: http://localhost:3000
API_KEY:   a1b2c3d4...
ADMIN_KEY: e5f6g7h8...

Suite 1 — Authentication
    [PASS] no key → 401                                       3ms
    [PASS] invalid key → 401                                  2ms
    [PASS] valid global key → 200                             8ms
    [PASS] project-scoped key + matching project → 200       12ms
    [PASS] project-scoped key + wrong project → 403           9ms
    [PASS] /keys without admin key → 401 or 503               4ms

Suite 2 — Store → Retrieve round-trip
    [PASS] store + retrieve exact match                      94ms
    [PASS] store 500 events (max) → 200                     312ms
    ...

ALL PASSED  21/21 tests  |  0 skipped  |  2841ms
Report → docs/HARNESS_REPORT_2026-05-03T12-00-00.md
```

---

## What you're running

- **Skills** — 27 Markdown prompts installed into your AI CLI. `/minus` is the master orchestrator.
- **OCR-Memory** — Rust/Axum HTTP service. Stores events as PNG + text, retrieves via vector → optical → trigram search. Backed by PostgreSQL + pgvector.
- **JS Orchestration layer** — `utils/` — spawns sub-agents via CLI or HTTP API, enforces PhaseReceipts, manages sessions, prunes context.

All three layers are independently useful. The memory service is optional for single-session work.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `minus: command not found` | Run `npm link` in the project root |
| `minus status` shows service unreachable | Run `minus start` (requires Docker) |
| `401 unauthorized` on store/retrieve | Set `API_KEY` in `.env` or `--api-key` flag |
| `401 unauthorized` on `/keys` | Set `ADMIN_KEY` in `.env` |
| Phase receipt validation failures | Check `.memory/sessions/{id}/DIAGNOSTIC.md` |
| HTTP provider gives 401 | Check `AGENT_API_KEY` matches provider format |
