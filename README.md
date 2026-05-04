# MinusWorkflows

A production-ready AI engineering system with two components that work independently or together:

- **Skill Stack** — 26 prompt-based skills installable into any AI CLI (Claude Code, Gemini CLI, or custom)
- **OCR-Memory Service** — a Rust/Axum HTTP API that gives AI agents durable, searchable visual and semantic memory

---

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│  AI Provider  (Claude Code · Gemini CLI · any CLI)       │
│  Skills invoked via  /minus  /architect  /builder ...    │
└─────────────────────┬────────────────────────────────────┘
                      │ orchestration (utils/)
┌─────────────────────▼────────────────────────────────────┐
│  JS Orchestration Layer                                   │
│  agent_runner · budget_tracker · cli_adapter             │
│  skill_registry · memory_pruner · scanner                │
└─────────────────────┬────────────────────────────────────┘
                      │ HTTP  localhost:3000
┌─────────────────────▼────────────────────────────────────┐
│  OCR-Memory Service  (Rust · Axum · Docker)              │
│  POST /memory/store     POST /memory/retrieve            │
│  GET  /health           GET  /metrics                    │
└───────┬─────────────────────────────┬────────────────────┘
        │                             │
┌───────▼──────────┐        ┌─────────▼────────┐
│  PostgreSQL      │        │  Redis (optional) │
│  + pgvector      │        │  standard / full  │
└──────────────────┘        └──────────────────┘
```

See [`docs/architecture.md`](docs/architecture.md) for a full breakdown.

---

## Quick Start

```bash
# 1. Install skills into your AI CLI(s)
node install.js

# 2. Copy and configure environment
cp .env.example .env        # edit at minimum: POSTGRES_PASSWORD, API_KEY

# 3. Start the memory service
docker-compose up --build
```

Then in Claude Code or Gemini CLI:
```
/minus build me a REST API for user authentication
```

---

## Runtime Modes

Switch by changing `MODE=` in `.env` — no rebuild required for `lite ↔ standard`.

| Mode | Cache | PII Scrubbing | Redis | Startup |
|---|---|---|---|---|
| `lite` | Disk (JSON) | Regex | Not required | Instant |
| `standard` | Redis | Regex | Required | Instant |
| `full` | Redis | NER (DistilBERT) | Required | Instant (model pre-baked in image) |

**Switching to `full`** (one-time rebuild bakes the NER model into the Docker layer):
```bash
# .env:  MODE=full  BUILD_FEATURES=ner
docker-compose build --build-arg FEATURES=ner
docker-compose up
```

---

## Provider Configuration

### AI CLI (sub-agent execution)

Set `AGENT_CLI` in `.env` to control which CLI runs skill sub-agents:

| Provider | `AGENT_CLI` | Default model |
|---|---|---|
| Claude Code (default) | `claude` | `claude-sonnet-4-6` |
| Gemini CLI | `gemini` | `gemini-2.0-flash` |
| OpenAI CLI | `openai` | `gpt-4o` |
| Any other | `custom` | set `AGENT_CLI_TEMPLATE` |

```bash
# Custom CLI example
AGENT_CLI=custom
AGENT_CLI_TEMPLATE="my-cli -p {prompt} --model {model}"
AGENT_DEFAULT_MODEL=my-model-id
AGENT_FAST_MODEL=my-cheap-model-id   # used for background tasks (memory pruning)
```

### Vision Backend (optical memory retrieval)

```bash
VISION_BACKEND=anthropic   # VISION_MODEL_ANTHROPIC=claude-sonnet-4-6
VISION_BACKEND=openai      # VISION_MODEL_OPENAI=gpt-4o
VISION_BACKEND=google      # gemini-2.0-flash
```

### Semantic Search (pgvector)

```bash
EMBEDDING_BACKEND=openai
EMBEDDING_MODEL=text-embedding-3-small
OPENAI_API_KEY=sk-...
```

When set, retrieval uses cosine similarity on 1536-dim embeddings stored in PostgreSQL, falling back to trigram search if no embedding exists.

---

## Authentication

`/memory/store` and `/memory/retrieve` require an API key when `API_KEY` is set. `/health` and `/metrics` are always public.

```bash
# In .env
API_KEY=your-strong-random-key   # generate: openssl rand -hex 32
```

Pass it as:
```
X-Api-Key: your-key
# or
Authorization: Bearer your-key
```

Omitting `API_KEY` disables auth — suitable for local development only.

---

## Skill Stack

26 skills covering the full engineering lifecycle. Install once, use from any supported AI CLI.

| Skill | Purpose |
|---|---|
| `/minus` | Master orchestrator — classifies intent and routes to all other skills |
| `/architect` | Grills requirements, produces structured PRDs |
| `/planner` | Breaks PRDs into dependency-tagged `TASKS.json` |
| `/orchestrator` | Analyzes task graph, selects serial or parallel topology |
| `/builder` | Implements tasks, runs tests, commits |
| `/maintainer` | Fast-track bug fixes and isolated changes |
| `/auditor` | Quality gate — validates output against requirements |
| `/evolve` | Captures lessons learned to `EVOLUTION.md` |
| `/diagnose` | Triages stack traces and error logs |
| `/tdd` | Test-driven development workflow |
| `/enforcer` | Linting, formatting, pre-commit standards |
| `/git-guardrails` | Safe git operations, branch protection rules |
| `/gitagent` | Autonomous git operations |
| `/github-triage` | Issue and PR triage automation |
| `/vault-harness` | Secure sandbox execution and rollback |
| `/ocr-memory` | Interface to the OCR-Memory HTTP service |
| `/mapper` | Dependency and impact mapping |
| `/discovery` | Codebase exploration and documentation |
| `/domain-model` | Entity relationship and schema modeling |
| `/control-pane` | Project health dashboard |
| `/grill-me` | Socratic requirement refinement |
| `/to-prd` | Convert rough ideas to formal PRDs |
| `/to-issues` | Convert PRDs to GitHub issues |
| `/agentic` | Long-horizon autonomous task execution |
| `/minustoken` | Token budget and context management |
| `/skills` | List all available skills |

Run `/skills` in your AI CLI to see the full live registry with versions.

---

## OCR-Memory HTTP API

Full reference: [`docs/api.md`](docs/api.md)

```bash
# Store a memory episode
curl -X POST http://localhost:3000/memory/store \
  -H "X-Api-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "episode_id":  "<uuid>",
    "project_id":  "<uuid>",
    "team_id":     "<uuid>",
    "user_id":     "<uuid>",
    "events": ["user clicked login", "form validated", "redirect to /dashboard"]
  }'

# Retrieve relevant memories
curl -X POST http://localhost:3000/memory/retrieve \
  -H "X-Api-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"query": "login flow", "project_id": "<uuid>"}'

# Service health
curl http://localhost:3000/health

# Prometheus metrics
curl http://localhost:3000/metrics
```

Retrieval priority: **vector search** (pgvector cosine) → **optical** (vision API + SoM) → **trigram** (pg_trgm fallback).

---

## Development

```bash
# Benchmark the memory service
npm run benchmark

# Rebuild skill registry (after adding or editing skills)
npm run skills

# Prune EVOLUTION.md when it grows too large
npm run prune-memory

# Run Rust service locally (without Docker)
cd ocr_memory_rust
DATABASE_URL=postgres://... REDIS_URL=redis://... cargo run
```

### Adding a skill

1. Create `skills/<name>/SKILL.md` with frontmatter (`name`, `description`, `version`)
2. Run `node install.js` — installs the skill and regenerates the registry

---

## Project Layout

```
MinusWorkflows/
├── install.js              # cross-platform installer
├── docker-compose.yml      # production compose (all three modes)
├── .env.example            # all env vars documented
├── skill_registry.json     # auto-generated by npm run skills
│
├── skills/                 # 26 AI skill definitions (Markdown)
│
├── ocr_memory_rust/        # Rust/Axum OCR-Memory service
│   ├── src/
│   │   ├── auth.rs         # API key middleware
│   │   ├── db.rs           # schema + migrations (pg_trgm, pgvector)
│   │   ├── embedder.rs     # OpenAI text embedding
│   │   ├── main.rs         # routes, store, retrieve, cache logic
│   │   ├── renderer.rs     # PNG trajectory renderer (SoM boxes)
│   │   ├── retriever.rs    # vision API + vector + trigram search
│   │   ├── scrubber.rs     # PII scrubber (regex / NER)
│   │   ├── state.rs        # AppState initialisation, mode detection
│   │   └── telemetry.rs    # structured logging + Prometheus
│   ├── Cargo.toml
│   └── Dockerfile
│
├── utils/                  # JS orchestration utilities
│   ├── agent_runner.js     # real sub-agent execution via CLI
│   ├── budget_tracker.js   # session cost and model tier control
│   ├── cli_adapter.js      # provider-aware CLI command builder
│   ├── failure_taxonomy.js # failure code classification (F-LOC … F-ENV)
│   ├── memory_pruner.js    # EVOLUTION.md auto-summarisation
│   ├── pytest_parser.js    # JUnit XML parser
│   ├── scanner.js          # AI model auto-detection
│   ├── skill_registry.js   # registry builder + /skills generator
│   └── skill_sync.js       # targeted skill sync to Gemini CLI
│
├── scripts/
│   ├── benchmark.js        # HTTP API benchmark suite
│   └── generate_report.js  # evaluation report generator
│
└── docs/
    ├── architecture.md     # system design
    └── api.md              # HTTP API reference
```

---

## License

MIT
