# Architecture

MinusWorkflows is a three-layer system. Each layer is independently useful and can be adopted without the others.

---

## Layer 1 — Skill Stack (Markdown prompts)

Located in `skills/`. Each skill is a Markdown file with YAML frontmatter:

```markdown
---
name: builder
description: Implements tasks, runs tests, commits
version: 1.0.0
---

[Prompt instructions...]
```

`install.js` copies skills into the format required by each AI CLI:

| CLI | Install location | Invocation |
|---|---|---|
| Claude Code | `~/.claude/commands/<name>.md` | `/builder` |
| Gemini CLI | `~/.gemini/skills/<name>/SKILL.md` | `Gemini, builder: [goal]` |
| Custom | `AGENT_CLI_TEMPLATE` | provider-specific |

Skills are pure text — they work with any AI that can read instructions.

---

## Layer 2 — JS Orchestration Layer (`utils/`)

Node.js utilities that the skill prompts reference for real execution:

| Module | Role |
|---|---|
| `cli_adapter.js` | Builds shell commands for the configured AI CLI (`AGENT_CLI` env) |
| `agent_runner.js` | Spawns real sub-agents via the CLI, logs to `.memory/sessions/` |
| `budget_tracker.js` | Enforces per-session cost limits and model tier controls |
| `scanner.js` | Auto-detects which AI models are available in the environment |
| `skill_registry.js` | Generates `skill_registry.json` and the `/skills` command |
| `memory_pruner.js` | Summarises `EVOLUTION.md` when it exceeds 50 KB |
| `failure_taxonomy.js` | Classifies failures by code (F-LOC, F-CTX, F-PAT, ...) |
| `pytest_parser.js` | Parses JUnit XML for test result metrics |
| `skill_sync.js` | Targeted sync of individual skills to Gemini CLI |

### Pipeline executor (mechanical enforcement)

`pipeline_executor.js` wraps every multi-phase skill run with code-enforced state machines. The pipeline never silently skips a broken phase.

```
pipeline_executor.run(goal, ['architect','planner','builder','auditor','evolve'])

  for each phase:
    ┌─ invoke agent (via agent_runner.invokeAgentWithReceipt)
    │
    ├─ parse last JSON block from output as PhaseReceipt
    │
    ├─ validate receipt against per-phase schema (pipeline_schemas.js)
    │    required fields per phase:
    │      architect  → prd_summary, requirements
    │      planner    → tasks_count, tasks_path
    │      builder    → files_changed, tests_passed
    │      auditor    → checks_passed, issues
    │      evolve     → heuristics_added
    │
    ├─ PASS → write receipt to receipts/{phase}.json, advance
    │
    └─ FAIL → inject failure context into next prompt, retry (up to PIPELINE_RETRY_LIMIT)
               exhausted retries → write DIAGNOSTIC.md, HALT
```

**Session directory layout:**
```
.memory/sessions/{session_id}/
  state.json         ← persistent state (phases_completed, retry_counts, halted)
  receipts/
    architect.json   ← written only after validation passes
    planner.json
    builder.json
    auditor.json
    evolve.json
  DIAGNOSTIC.md      ← written only on exhausted retries
```

### Auth: per-project API keys

The OCR-Memory service uses SHA-256 hashed keys stored in the `api_keys` table instead of a single env `API_KEY`. Each key can be scoped to one `project_id`; global keys (no scope) access all projects.

```
request
  │  X-Api-Key or Authorization: Bearer
  ▼
api_keys middleware
  1. Hash incoming key with SHA-256
  2. Lookup api_keys by key_hash
  3. Check expires_at (if set)
  4. Inject ResolvedKey extension (key_id, project_id, label)
  5. Enforce project scope — 403 if key.project_id ≠ request.project_id
  6. Fallback: compare raw key to API_KEY env (backward compat)
```

Key management via `utils/key_manager.js` or HTTP:
```
POST   /keys          create (returns raw key once)
DELETE /keys/{id}     revoke
GET    /keys          list (hashes only, never raw)
```

### Distributed tracing via correlation IDs

Every request carries `X-Request-Id` through all layers:

```
JS agent_runner spawns sub-agent
  req_id = randomUUID()
  → appended to every line in .memory/sessions/**/*.log
  → passed as X-Request-Id header to OCR-Memory service

Rust service receives X-Request-Id
  → recorded on tracing span (appears in every JSON log line)
  → echoed back in response X-Request-Id header

grep req_id:abc-123 .memory/sessions/**/*.log   → full JS trace
grep abc-123 /var/log/ocr_engine.json           → full Rust trace
```

### Provider switching

`cli_adapter.js` centralises all CLI command construction. Changing `AGENT_CLI` in `.env` switches every utility simultaneously — no code changes required.

```
AGENT_CLI=claude   →  claude -p {prompt} --model {model}
AGENT_CLI=gemini   →  gemini -p {prompt} --model {model}
AGENT_CLI=openai   →  openai api responses.create -t {prompt} --model {model}
AGENT_CLI=custom   →  $AGENT_CLI_TEMPLATE (with {prompt} and {model} substituted)
```

---

## Layer 3 — OCR-Memory Service (`ocr_memory_rust/`)

A Rust/Axum HTTP server that stores episodic memories as compressed PNG images and text logs, then retrieves them via a three-tier search pipeline.

### Data model

```
episodes
  id UUID PK
  project_id UUID         ← multi-tenant isolation
  team_id UUID
  user_id UUID
  name TEXT
  embedding vector(1536)  ← pgvector, nullable
  created_at TIMESTAMPTZ

text_logs
  id UUID PK
  episode_id UUID FK → episodes
  project_id UUID
  team_id UUID
  user_id UUID
  content TEXT            ← scrubbed event text
  seq_index INTEGER       ← maps to SoM box number in PNG
  created_at TIMESTAMPTZ

visual_memories
  id UUID PK
  episode_id UUID FK → episodes
  image_path TEXT         ← absolute path under MEMORY_BASE_DIR
  resolution_width INTEGER
  resolution_height INTEGER
  created_at TIMESTAMPTZ

api_keys
  id UUID PK
  key_hash TEXT UNIQUE    ← SHA-256 of raw key, never plaintext
  project_id UUID NULL    ← NULL = global access
  label TEXT
  created_at TIMESTAMPTZ
  expires_at TIMESTAMPTZ NULL
  last_used_at TIMESTAMPTZ NULL
```

### Store pipeline

```
POST /memory/store
  1. Validate + scrub PII (regex always; NER if --features ner)
  2. Render PNG with numbered SoM boxes (TrajectoryRenderer)
  3. Write PNG to {MEMORY_BASE_DIR}/{project_id}/{episode_id}.png
  4. Atomic DB transaction: episodes + visual_memories + text_logs
     ↳ filesystem rollback (delete PNG) on transaction failure
  5. Invalidate cache (Redis INCR version key, or disk prefix-delete)
  6. Background: embed_text(events) → pgvector (tokio::spawn, non-blocking)
```

### Retrieve pipeline

```
POST /memory/retrieve
  1. Check cache (disk JSON or Redis SETEX/GET)
     ↳ cache hit → return immediately
  2. Spawn background active-recall sharpener (re-renders cold low-res images)
  3. Vector search (if EMBEDDING_BACKEND set)
     ↳ embed query → SELECT ORDER BY embedding <=> $1
     ↳ empty result → fall through to next tier
  4. Optical retrieval (if VISION_BACKEND set)
     ↳ load latest episode PNG → vision API → SoM indices → text_logs by seq_index
     ↳ empty result → fall through
  5. Trigram text search (pg_trgm, always available)
     ↳ ILIKE + pg_trgm similarity fallback
  6. Cache result, return
```

### Runtime modes

| Mode | `CacheBackend` | Scrubber | Extra dep |
|---|---|---|---|
| `lite` | `Disk(PathBuf)` | regex only | none |
| `standard` | `Redis(ConnectionManager)` | regex only | Redis |
| `full` | `Redis(ConnectionManager)` | NER | Redis + model (pre-baked in Docker layer) |

Mode is read from `MODE` env at startup — no rebuild required to switch `lite ↔ standard`.

### Cargo features

```toml
[features]
ner = ["candle-core", "candle-transformers", "candle-nn", "tokenizers", "hf-hub"]
```

The default build excludes all ML dependencies (~8 MB binary, instant start). The `ner` feature adds ~80 MB to the binary and requires the pre-baked DistilBERT model.

### Observability

| Endpoint | Description |
|---|---|
| `GET /health` | DB ping + cache ping; returns `{"status":"ok\|degraded"}` |
| `GET /metrics` | Prometheus text format |

Key metrics:
- `ocr_memory_store_requests_total{status}` — store success/error rate
- `ocr_memory_retrieve_requests_total{status,cache}` — retrieve rate by cache hit/miss
- `ocr_memory_retrieve_path_total{path}` — retrieval path taken (vector/optical/text)
- `ocr_memory_vision_api_tokens_total{backend,direction}` — API token consumption
- `ocr_memory_embedding_tokens_total{backend}` — embedding token consumption
- `ocr_memory_store_duration_seconds` — store latency histogram
- `ocr_memory_retrieve_duration_seconds` — retrieve latency histogram

---

## Memory and Evolution

The skill system maintains its own learning state:

```
.memory/
  EVOLUTION.md          ← validated heuristics and lessons (auto-pruned at 50 KB)
  EVOLUTION_ARCHIVE.md  ← verbatim archive of pruned content
  retention.log         ← output of retention_cron.js runs
  skill_versions.json   ← installed skill version tracking
  INDEX.md              ← optional session index
  sessions/
    {session_id}/
      state.json        ← pipeline state machine (phases_completed, retry_counts, halted)
      receipts/         ← validated PhaseReceipt JSON per phase
      {skill}.log       ← per-skill agent invocation logs with req_id correlation
      DIAGNOSTIC.md     ← written on exhausted retries (halted session)
```

`.vault/` holds rollback backups, failed task debris, and archived episodes:
```
.vault/
  backups/              ← committed
  sandbox/              ← gitignored (failed task debris)
  archive/
    {project_id}/       ← PNGs copied here when RETENTION_ARCHIVE=true
```
