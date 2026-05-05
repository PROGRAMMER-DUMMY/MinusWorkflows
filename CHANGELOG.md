# Changelog

All notable changes to MinusWorkflows are documented here.

## [2.0.5] — 2026-05-05

### Fixed
- **Project scope enforcement** — `store_memory` and `retrieve_memory` now extract `ResolvedKey` and return 403 when a project-scoped API key is used against a non-matching `project_id`. Previously all authenticated requests passed regardless of scope.
- **CI rate limit** — added `RATE_LIMIT_RPM=500` to integration job env; the default 60 RPM was exhausted by the ~70 requests across harness suites before Suite 5 ran, causing false 429 failures.

### Changed
- **Redis** bumped `0.24 → 0.25` — removes deprecated Rust syntax that would be rejected by future compiler versions.
- **`auth.rs` deleted** — superseded by `api_keys::auth_middleware` (DB-backed keys with `ResolvedKey` injection). The old env-only middleware was never wired up.

### Removed
- Dead `scope` field from `RetrieveRequest` (never consumed; serde ignores the JSON field from existing clients automatically).
- Dead `retrieve_indices` wrapper method on `VisionClient` (only `retrieve_indices_with_usage` was called anywhere).

---

## [2.0.4] — 2026-05-05

### Fixed
- **`Box<dyn Error>` non-`Send` in async chains** — added `+ Send + Sync` bounds to all `Box<dyn Error>` return types in `optical_retrieve` (main.rs), all `VisionClient` methods (retriever.rs), and `init_scrubber`/`init_ner` (scrubber.rs). These made Futures non-`Send`, breaking the axum `Handler` trait impl and `tokio::task::spawn_blocking`.
- Removed unused `Extension` import from `api_keys.rs`.

---

## [2.0.3] — 2026-05-05

### Fixed
- **`#[instrument]` with `String` field** — removed `query = %payload.0.query` from the `retrieve_memory` instrument macro. Borrowing a non-Copy field conflicted with moving `payload` into the async body, making the Future non-`Send`.
- **CI workflows** — updated `actions/checkout@v4 → @v5`, Node.js `20 → 24`, `docker/build-push-action@v5 → @v6`, and `npm install → npm ci` across both `ci.yml` and `release.yml`.

---

## [2.0.2] — 2026-05-04

### Fixed
- **sqlx + pgvector version matrix** — `pgvector 0.4.1` implements sqlx **0.8** traits (not 0.7). Final versions: `sqlx = "0.8"` + `pgvector = "0.4"`.
- **`sqlx::query!` macro in Docker builds** — the checked macro requires a live database at compile time; Docker builds have none. Converted all `query!` calls to `query()` across `api_keys.rs`, `retriever.rs`, and `main.rs`, adding `use sqlx::Row` and replacing field access with `row.try_get("field")`.
- **`ab_glyph` API change** — `Glyph::positioned()` was removed in newer 0.2.x releases. Fixed by setting `glyph.position` directly as a public field.

---

## [2.0.1] — 2026-05-04

### Fixed
- `pgvector = "^0.5"` does not exist on crates.io — downgraded to `"0.4"`.
- npm publish `EOTP` error — Classic npm tokens require OTP in CI; replaced with Granular Access Token + OIDC Trusted Publishing (no stored secret).

---

## [2.0.0] — 2026-05-03

### Breaking changes
- `docker-compose.yml` now uses `pgvector/pgvector:pg15` instead of `postgres:15-alpine` — required for semantic search. Run `docker-compose down -v && docker-compose up --build` when upgrading.
- `MODE=full` no longer downloads the NER model at first start. The model is baked into the Docker image at build time (`docker-compose build --build-arg FEATURES=ner`).

### Added
- **API key authentication** (`auth.rs`) — `X-Api-Key` / `Authorization: Bearer` on all `/memory/*` routes. `/health` and `/metrics` remain public. Disabled when `API_KEY` env is unset (dev mode).
- **Portable image paths** — all PNGs stored under `MEMORY_BASE_DIR` env (default `./memory_bank`) rather than relative to CWD. Survives container restarts.
- **pgvector semantic search** — `episodes.embedding vector(1536)` column, HNSW index, cosine `<=>` queries. Retrieval priority: vector → optical → trigram.
- **OpenAI text embedding** (`embedder.rs`) — `EMBEDDING_BACKEND=openai` + `EMBEDDING_MODEL` env. Stored after every `store_memory` call in a background task.
- **Provider-aware agent runner** (`utils/cli_adapter.js`) — `AGENT_CLI=claude|gemini|openai|custom` with `AGENT_CLI_TEMPLATE` for any other CLI. Default model per provider, overridable via `AGENT_DEFAULT_MODEL`.
- **Real sub-agent execution** (`utils/agent_runner.js`) — invokes `claude -p` (or configured CLI) as an actual subprocess. Logs to `.memory/sessions/[sessionId]/[skill].log`. Topology collapse on first failure in serial mode.
- **Skill registry** (`utils/skill_registry.js`, `skill_registry.json`) — auto-generated from SKILL.md frontmatter. Regenerated on every `node install.js` run.
- **`/skills` slash command** — auto-generated `skills/skills/SKILL.md` listing all 26 skills with descriptions and versions.
- **Skill versioning** — `version:` field in all SKILL.md frontmatters. `install.js` tracks installed versions in `.memory/skill_versions.json` and logs upgrades.
- **Memory auto-pruning** (`utils/memory_pruner.js`) — summarises `EVOLUTION.md` via the active AI CLI when it exceeds 50 KB. Archives verbatim content first.
- **Token tracking** — vision API calls now parse and emit `ocr_memory_vision_api_tokens_total{direction=input|output}` Prometheus counters for all three backends (Anthropic, OpenAI, Google).
- **NER model pre-baked** — Dockerfile accepts `PREBAKE_ONLY=1` to download the DistilBERT model at build time, eliminating the first-start delay.
- **Configurable vision models** — `VISION_MODEL_ANTHROPIC` (default `claude-sonnet-4-6`) and `VISION_MODEL_OPENAI` (default `gpt-4o`).
- **`/budget` groundwork** — vision API and embedding token counts exposed via Prometheus; `recordCost()` in `budget_tracker.js` wired to session cost tracking.
- **`AGENT_FAST_MODEL` env** — separate model for cheap background tasks (memory pruning).
- **`npm run skills`** and **`npm run prune-memory`** scripts added to `package.json`.
- **`docs/architecture.md`** and **`docs/api.md`** — new developer documentation.
- **`model_cache` Docker volume** — persists pre-baked NER model across image rebuilds.

### Fixed
- CI pipeline failure in `npm version` sync step — now uses `--allow-same-version` to prevent crashes when versions already match.
- Rust Docker build failure — updated base image to `rust:1.85-slim` to support dependencies requiring `edition2024` (e.g., `idna_adapter`).

### Changed
- `skills/minus/SKILL.md` step -1: `uvx code-review-graph update` is now best-effort — logs a warning and continues if the command is unavailable, never blocks.
- Anthropic vision model updated from hardcoded `claude-3-5-sonnet-20240620` to configurable `claude-sonnet-4-6`.
- `retrieve_memory` search path refactored into `optical_or_text()` helper; vector search is the new first priority.
- `docker-compose.yml` adds `model_cache` volume and new env vars: `API_KEY`, `MEMORY_BASE_DIR`, `VISION_MODEL_ANTHROPIC`, `VISION_MODEL_OPENAI`, `EMBEDDING_BACKEND`, `EMBEDDING_MODEL`.
- `.env.example` updated with all new env vars and inline documentation.
- `install.js` updated to rebuild skill registry and track skill versions on every install run.

### Removed
- `install.sh` — superseded by the cross-platform `install.js`.
- `config.yaml` — superseded by `.env.example`.
- `QUICKSTART.md` — content merged into `README.md`.
- `pyproject.toml` — placeholder with no dependencies; removed to avoid confusion.
- `test_app.py` — orphaned file with no purpose.
- `gitagent.skill` — binary artifact from prior packaging, not a valid skill definition.
- `scripts/docker_harness.sh` and `docker/` — SWE-bench evaluation harness; not part of core product.

---

## [1.2.0] — prior

- Unified single `docker-compose.yml` (replaced three separate compose files)
- Multi-provider install: Claude Code (`~/.claude/commands/`) + Gemini CLI (`~/.gemini/skills/`)
- `scripts/benchmark.js` rewritten with native `fetch` + `crypto.randomUUID()` (removed axios/uuid deps)
- Background active recall moved to `tokio::spawn` (non-blocking off hot retrieve path)
- Atomic DB transactions in `store_memory` with filesystem rollback on failure
- Versioned Redis cache keys (`INCR version:{project_id}` on every store)
- Structured JSON tracing (`telemetry.rs`), Prometheus metrics, `/health`, `/metrics` endpoints
- `seq_index` column on `text_logs` for 1-based optical index mapping
- GIN trigram index on `text_logs.content`
- Font panic fixed in `renderer.rs` — returns blank PNG instead of crashing
- `reqwest` bumped `0.11 → 0.12` to resolve hyper version conflict with axum 0.7

## [1.0.0] — initial release

- 25-skill engineering stack for Gemini CLI
- OCR-Memory Rust service: store + retrieve + visual memory bank
- Three deployment modes: lite / standard / full
- PII scrubbing: regex (default) + optional NER via DistilBERT (candle)
