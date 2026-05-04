# OCR-Memory HTTP API Reference

Base URL: `http://localhost:3000` (configurable — service binds `0.0.0.0:3000`)

All `/memory/*` endpoints require authentication when `API_KEY` is set in the environment.

---

## Authentication

Pass one of:

```
X-Api-Key: <your-key>
Authorization: Bearer <your-key>
```

`/health` and `/metrics` are always public. If `API_KEY` is not set in the environment, auth is skipped on all routes (development only).

---

## POST /memory/store

Store an episode as a visual memory and text log.

### Request

```json
{
  "episode_id":  "550e8400-e29b-41d4-a716-446655440000",
  "project_id":  "550e8400-e29b-41d4-a716-446655440001",
  "team_id":     "550e8400-e29b-41d4-a716-446655440002",
  "user_id":     "550e8400-e29b-41d4-a716-446655440003",
  "events": [
    "user navigated to /login",
    "entered email address",
    "submitted form",
    "redirected to /dashboard"
  ]
}
```

| Field | Type | Constraints |
|---|---|---|
| `episode_id` | UUID | must be client-generated |
| `project_id` | UUID | used for multi-tenant isolation and cache invalidation |
| `team_id` | UUID | sub-tenant isolation |
| `user_id` | UUID | sub-tenant isolation |
| `events` | `string[]` | 1–500 items; each ≤ 10,000 chars |

### Response

`200 OK` — empty body on success.

`400 Bad Request` — validation failure (empty events, too many events, event too long).

`500 Internal Server Error` — database or filesystem error (PNG write, transaction failure).

### What happens

1. Each event is PII-scrubbed (regex; NER if full mode).
2. A 1024×1024 PNG is rendered with numbered Set-of-Mark boxes.
3. The PNG is saved to `{MEMORY_BASE_DIR}/{project_id}/{episode_id}.png`.
4. An atomic transaction writes: `episodes`, `visual_memories`, `text_logs` (with `seq_index`).
5. Cache is invalidated for the project.
6. A background task embeds the scrubbed text and stores a `vector(1536)` in `episodes.embedding` (if `EMBEDDING_BACKEND` is set).

---

## POST /memory/retrieve

Retrieve relevant memories for a query.

### Request

```json
{
  "query":      "user login flow",
  "project_id": "550e8400-e29b-41d4-a716-446655440001",
  "scope":      "recent"
}
```

| Field | Type | Required |
|---|---|---|
| `query` | string | yes |
| `project_id` | UUID | yes |
| `scope` | string | no (reserved for future use) |

### Response

`200 OK`

```json
[
  "user navigated to /login",
  "entered email address",
  "submitted form",
  "redirected to /dashboard"
]
```

A flat array of matching event strings, ordered by relevance.

### Search tiers (in priority order)

1. **Cache** — Redis `GET` or disk JSON with TTL check. Instant return on hit.
2. **Vector search** — pgvector cosine distance on `episodes.embedding`. Only runs when `EMBEDDING_BACKEND` is set and the episode has a stored embedding.
3. **Optical retrieval** — loads latest episode PNG → vision API → SoM indices → `text_logs` by `seq_index`. Only runs when `VISION_BACKEND` is set.
4. **Trigram text search** — `pg_trgm` similarity + `ILIKE` on `text_logs.content`. Always available as final fallback.

Results are cached (TTL: 300 seconds) after retrieval.

A background `tokio::spawn` task re-renders any low-resolution images in the project (active recall sharpening) — this does not block the response.

---

## GET /health

Returns service health. No authentication required.

### Response

`200 OK` — all systems healthy.

`503 Service Unavailable` — one or more systems degraded.

```json
{
  "status": "ok",
  "db":     "ok",
  "cache":  "ok (disk)",
  "mode":   "lite"
}
```

| `cache` value | Meaning |
|---|---|
| `ok (disk)` | Lite mode, cache directory exists |
| `ok (redis)` | Standard/full mode, Redis responding to PING |
| `error (disk dir missing)` | Lite mode, cache directory not found |
| `error (redis)` | Redis not responding |

| `mode` | Description |
|---|---|
| `lite` | Disk cache, regex scrubbing |
| `standard` | Redis cache, regex scrubbing |
| `full` | Redis cache, NER scrubbing |

---

## GET /metrics

Returns Prometheus-format metrics. No authentication required.

```
Content-Type: text/plain; version=0.0.4
```

### Key metrics

| Metric | Labels | Description |
|---|---|---|
| `ocr_memory_store_requests_total` | `status` | Store call count by outcome |
| `ocr_memory_store_duration_seconds` | — | Store latency histogram |
| `ocr_memory_retrieve_requests_total` | `status`, `cache` | Retrieve call count by cache outcome |
| `ocr_memory_retrieve_duration_seconds` | — | Retrieve latency histogram |
| `ocr_memory_retrieve_path_total` | `path` | Retrieval path taken (`vector`/`optical`/`text`) |
| `ocr_memory_vision_api_requests_total` | `backend`, `status` | Vision API call count |
| `ocr_memory_vision_api_duration_seconds` | `backend` | Vision API latency histogram |
| `ocr_memory_vision_api_tokens_total` | `backend`, `direction` | Input/output token consumption |
| `ocr_memory_embedding_tokens_total` | `backend` | Embedding token consumption |
| `ocr_memory_embeddings_stored_total` | — | Successfully stored embeddings |
| `ocr_memory_redis_cache_operations_total` | `op`, `status` | Cache get/set operations |
| `ocr_memory_active_recall_spawned_total` | — | Background sharpening tasks spawned |

---

---

## Key Management (admin-only)

All `/keys` and `/admin/*` endpoints require `X-Admin-Key: <ADMIN_KEY>` (or `X-Api-Key`).
`ADMIN_KEY` must be set in the server environment — endpoints return `503` if it is missing.

### POST /keys

Create a new API key, optionally scoped to a project.

```json
{
  "label":           "team-alpha",
  "project_id":      "550e8400-e29b-41d4-a716-446655440001",
  "expires_in_days": 90
}
```

| Field | Type | Required |
|---|---|---|
| `label` | string | yes |
| `project_id` | UUID | no (omit for global key) |
| `expires_in_days` | integer | no (omit for never-expires) |

`201 Created`

```json
{
  "id":         "...",
  "raw_key":    "mk_abc123...",
  "project_id": "...",
  "label":      "team-alpha",
  "expires_at": "2026-08-01T00:00:00Z"
}
```

**The `raw_key` is shown once and never stored. Save it immediately.**

A project-scoped key is rejected (`403`) if used to access a different `project_id`.
A global key (no `project_id`) may access any project.

---

### DELETE /keys/{id}

Revoke a key immediately.

`204 No Content` — revoked.

`404 Not Found` — key not found.

---

### GET /keys

List all keys. Raw key values are never returned.

`200 OK`

```json
[
  {
    "id":           "...",
    "project_id":   "...",
    "label":        "team-alpha",
    "created_at":   "2026-05-01T00:00:00Z",
    "expires_at":   "2026-08-01T00:00:00Z",
    "last_used_at": "2026-05-03T12:00:00Z"
  }
]
```

---

## POST /admin/retention/run

Run the retention policy manually. Reads configuration from env vars:

| Env var | Effect |
|---|---|
| `RETENTION_TTL_DAYS=90` | Delete episodes older than 90 days |
| `RETENTION_MAX_EPISODES=500` | Delete oldest episodes beyond 500 per project |
| `RETENTION_ARCHIVE=true` | Copy PNGs to `.vault/archive/{project_id}/` before deleting |

Both policies run together in a single call; neither runs if its env var is unset.

`200 OK`

```json
{
  "deleted_episodes": 42,
  "freed_bytes":      1073741824,
  "archived_pngs":   42
}
```

---

## Correlation IDs

Pass `X-Request-Id: <uuid>` on any request. The same ID is:
- Echoed back in the response `X-Request-Id` header
- Recorded in every structured log line for that request (Rust tracing spans)
- Stamped on JS-layer log lines in `.memory/sessions/*.log`

```bash
grep "my-req-id" .memory/sessions/**/*.log   # full JS trace
grep "my-req-id" /var/log/ocr_engine.json    # full Rust trace
```

---

## Error responses

All errors return `Content-Type: application/json` where applicable.

| Code | Body | Cause |
|---|---|---|
| `400` | `"events cannot be empty"` | Zero events in store request |
| `400` | `"max 500 events"` | Exceeded event count limit |
| `400` | `"event exceeds 10000 chars"` | Single event too long |
| `401` | `{"error":"unauthorized"}` | Missing or incorrect API key |
| `500` | `"filesystem error"` | PNG write failed |
| `500` | `"database error"` | Transaction failed (PNG is cleaned up) |
| `503` | — | Health check: service degraded |
