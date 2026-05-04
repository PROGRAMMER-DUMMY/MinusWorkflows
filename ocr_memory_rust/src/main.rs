mod api_keys;
mod auth;
mod db;
mod embedder;
mod state;
mod retriever;
mod renderer;
mod scrubber;
mod telemetry;

use axum::{
    extract::State,
    http::{header, HeaderMap, StatusCode},
    middleware,
    response::IntoResponse,
    routing::{delete, get, post},
    Json, Router,
};
use std::time::{SystemTime, UNIX_EPOCH};
use metrics::{counter, histogram};
use serde::{Deserialize, Serialize};
use state::{init_state, AppState, CacheBackend};
use std::sync::Arc;
use std::time::Instant;
use tower_http::trace::TraceLayer;
use tracing::{error, info, instrument, warn};
use uuid::Uuid;
use sqlx::Row;

use crate::renderer::TrajectoryRenderer;
use crate::retriever::{Backend, VisionClient};

const MAX_EVENTS: usize = 500;
const MAX_EVENT_LEN: usize = 10_000;
const CACHE_TTL_SECS: u64 = 300;

// ── Request / Response types ──────────────────────────────────────────────────

#[derive(Deserialize)]
struct StoreRequest {
    episode_id: Uuid,
    project_id: Uuid,
    team_id: Uuid,
    user_id: Uuid,
    events: Vec<String>,
}

#[derive(Deserialize)]
struct RetrieveRequest {
    query: String,
    project_id: Uuid,
    scope: Option<String>,
}

#[derive(Serialize)]
struct HealthResponse {
    status: String,
    db: String,
    cache: String,
    mode: String,
}

// ── Entry point ───────────────────────────────────────────────────────────────

#[tokio::main]
async fn main() {
    let prometheus = telemetry::init_metrics();
    telemetry::init_tracing();

    let state = Arc::new(init_state(prometheus).await);

    // PREBAKE_ONLY=1: download NER model at Docker build time then exit cleanly.
    if std::env::var("PREBAKE_ONLY").as_deref() == Ok("1") {
        info!("PREBAKE_ONLY mode: scrubber initialized, model cached — exiting");
        return;
    }

    // Public routes — no auth required
    let public = Router::new()
        .route("/health", get(health_check))
        .route("/metrics", get(metrics_endpoint));

    // Protected routes — rate limit → auth → handler
    let protected = Router::new()
        .route("/memory/store", post(store_memory))
        .route("/memory/retrieve", post(retrieve_memory))
        .route_layer(middleware::from_fn_with_state(
            Arc::clone(&state),
            api_keys::auth_middleware,
        ))
        .route_layer(middleware::from_fn_with_state(
            Arc::clone(&state),
            rate_limit_middleware,
        ));

    // Admin routes — require ADMIN_KEY env var
    let admin = Router::new()
        .route("/keys", post(api_keys::create_key).get(api_keys::list_keys))
        .route("/keys/:id", delete(api_keys::revoke_key))
        .route("/keys/:id/rotate", post(api_keys::rotate_key))
        .route("/admin/audit", get(api_keys::list_audit))
        .route("/admin/retention/run", post(retention_run))
        .route_layer(middleware::from_fn(api_keys::admin_auth_middleware));

    let app = public
        .merge(protected)
        .merge(admin)
        .layer(middleware::from_fn(req_id_middleware))
        .layer(TraceLayer::new_for_http())
        .with_state(state);

    let listener = tokio::net::TcpListener::bind("0.0.0.0:3000").await.unwrap();
    info!("listening on {}", listener.local_addr().unwrap());
    axum::serve(listener, app).await.unwrap();
}

// ── Observability ─────────────────────────────────────────────────────────────

async fn health_check(state: State<Arc<AppState>>) -> impl IntoResponse {
    let state = state.0;
    let db_ok = sqlx::query("SELECT 1").execute(&state.db).await.is_ok();

    let cache_status = match &state.cache {
        CacheBackend::Disk(dir) => {
            if dir.exists() { "ok (disk)".to_string() } else { "error (disk dir missing)".to_string() }
        }
        CacheBackend::Redis(conn) => {
            let mut c = conn.clone();
            let ok = redis::cmd("PING")
                .query_async::<_, String>(&mut c)
                .await
                .map(|r| r == "PONG")
                .unwrap_or(false);
            if ok { "ok (redis)".to_string() } else { "error (redis)".to_string() }
        }
    };

    let all_ok = db_ok && !cache_status.starts_with("error");
    let body = HealthResponse {
        status: if all_ok { "ok".into() } else { "degraded".into() },
        db: if db_ok { "ok".into() } else { "error".into() },
        cache: cache_status,
        mode: format!("{:?}", state.mode).to_lowercase(),
    };

    let status = if all_ok { StatusCode::OK } else { StatusCode::SERVICE_UNAVAILABLE };
    (status, Json(body))
}

async fn metrics_endpoint(state: State<Arc<AppState>>) -> impl IntoResponse {
    let state = state.0;
    (
        StatusCode::OK,
        [(header::CONTENT_TYPE, "text/plain; version=0.0.4")],
        state.prometheus.render(),
    )
}

// ── Store ─────────────────────────────────────────────────────────────────────

#[instrument(skip_all, fields(episode_id = %payload.0.episode_id, project_id = %payload.0.project_id, n = payload.0.events.len(), req_id = tracing::field::Empty))]
async fn store_memory(
    state: State<Arc<AppState>>,
    headers: HeaderMap,
    payload: Json<StoreRequest>,
) -> impl IntoResponse {
    let state = state.0;
    let payload = payload.0;
    let start = Instant::now();
    tracing::Span::current().record("req_id", telemetry::request_id(&headers).as_str());

    if payload.events.is_empty() {
        return (StatusCode::BAD_REQUEST, "events cannot be empty").into_response();
    }
    if payload.events.len() > MAX_EVENTS {
        return (StatusCode::BAD_REQUEST, format!("max {} events", MAX_EVENTS)).into_response();
    }
    if payload.events.iter().any(|e| e.len() > MAX_EVENT_LEN) {
        return (StatusCode::BAD_REQUEST, format!("event exceeds {} chars", MAX_EVENT_LEN)).into_response();
    }

    let scrubbed: Vec<String> = payload.events.iter().map(|e| state.scrubber.scrub(e)).collect();

    // Render PNG (numbered SoM boxes)
    let image_bytes = TrajectoryRenderer::new().render_trajectory(scrubbed.clone(), (1024, 1024));

    // Use MEMORY_BASE_DIR — portable across container restarts
    let image_dir = state.memory_base.join(payload.project_id.to_string());
    let _ = std::fs::create_dir_all(&image_dir);
    let image_path = image_dir.join(format!("{}.png", payload.episode_id));

    if let Err(e) = std::fs::write(&image_path, &image_bytes) {
        error!("image write failed: {}", e);
        counter!("ocr_memory_store_requests_total", "status" => "error").increment(1);
        return (StatusCode::INTERNAL_SERVER_ERROR, "filesystem error").into_response();
    }

    let image_path_str = image_path
        .canonicalize()
        .unwrap_or_else(|_| image_path.clone())
        .to_string_lossy()
        .to_string();

    // Atomic transaction
    let tx_result: Result<(), sqlx::Error> = async {
        let mut tx = state.db.begin().await?;

        sqlx::query(
            "INSERT INTO episodes (id, project_id, team_id, user_id, name) \
             VALUES ($1, $2, $3, $4, $5) ON CONFLICT (id) DO NOTHING",
        )
        .bind(payload.episode_id).bind(payload.project_id)
        .bind(payload.team_id).bind(payload.user_id)
        .bind(format!("Episode {}", payload.episode_id))
        .execute(&mut *tx).await?;

        sqlx::query("DELETE FROM visual_memories WHERE episode_id = $1")
            .bind(payload.episode_id).execute(&mut *tx).await?;

        sqlx::query(
            "INSERT INTO visual_memories (episode_id, image_path, resolution_width, resolution_height) \
             VALUES ($1, $2, $3, $4)",
        )
        .bind(payload.episode_id).bind(&image_path_str)
        .bind(1024i32).bind(1024i32)
        .execute(&mut *tx).await?;

        sqlx::query("DELETE FROM text_logs WHERE episode_id = $1")
            .bind(payload.episode_id).execute(&mut *tx).await?;

        for (idx, event) in scrubbed.iter().enumerate() {
            sqlx::query(
                "INSERT INTO text_logs \
                 (project_id, team_id, user_id, episode_id, content, seq_index) \
                 VALUES ($1, $2, $3, $4, $5, $6)",
            )
            .bind(payload.project_id).bind(payload.team_id)
            .bind(payload.user_id).bind(payload.episode_id)
            .bind(event).bind(idx as i32)
            .execute(&mut *tx).await?;
        }

        tx.commit().await
    }
    .await;

    if let Err(e) = tx_result {
        error!("transaction failed: {}", e);
        let _ = std::fs::remove_file(&image_path);
        counter!("ocr_memory_store_requests_total", "status" => "error").increment(1);
        return (StatusCode::INTERNAL_SERVER_ERROR, "database error").into_response();
    }

    // Generate and store vector embedding (non-blocking best-effort)
    {
        let db = state.db.clone();
        let episode_id = payload.episode_id;
        let text = scrubbed.join(" ");
        tokio::spawn(async move {
            if let Some(vec) = embedder::embed_text(&text).await {
                let embedding = pgvector::Vector::from(vec);
                let _ = sqlx::query(
                    "UPDATE episodes SET embedding = $1 WHERE id = $2"
                )
                .bind(embedding)
                .bind(episode_id)
                .execute(&db)
                .await;
                counter!("ocr_memory_embeddings_stored_total").increment(1);
            }
        });
    }

    cache_invalidate(&state.cache, payload.project_id).await;

    let n_events = scrubbed.len();
    let req_id_str = telemetry::request_id(&headers);
    fire_webhook("store", payload.project_id, payload.episode_id, n_events, req_id_str);

    let elapsed = start.elapsed().as_secs_f64();
    counter!("ocr_memory_store_requests_total", "status" => "ok").increment(1);
    histogram!("ocr_memory_store_duration_seconds").record(elapsed);
    info!(events = n_events, elapsed_s = elapsed, "store complete");

    StatusCode::OK.into_response()
}

// ── Retrieve ──────────────────────────────────────────────────────────────────

#[instrument(skip_all, fields(project_id = %payload.0.project_id, query = %payload.0.query, req_id = tracing::field::Empty))]
async fn retrieve_memory(
    state: State<Arc<AppState>>,
    headers: HeaderMap,
    payload: Json<RetrieveRequest>,
) -> impl IntoResponse {
    let state = state.0;
    let payload = payload.0;
    let start = Instant::now();
    tracing::Span::current().record("req_id", telemetry::request_id(&headers).as_str());

    let cache_key = build_cache_key(&state.cache, payload.project_id, &payload.query).await;

    if let Some(results) = cache_get(&state.cache, &cache_key).await {
        counter!("ocr_memory_retrieve_requests_total", "status" => "ok", "cache" => "hit").increment(1);
        histogram!("ocr_memory_retrieve_duration_seconds").record(start.elapsed().as_secs_f64());
        return (StatusCode::OK, Json(results)).into_response();
    }
    counter!("ocr_memory_redis_cache_operations_total", "op" => "get", "status" => "miss").increment(1);

    // Background active-recall sharpening (non-blocking)
    {
        let db = state.db.clone();
        let pid = payload.project_id;
        tokio::spawn(async move {
            if let Err(e) = sharpen_cold_memories(&db, pid).await {
                warn!("active recall: {}", e);
            }
        });
        counter!("ocr_memory_active_recall_spawned_total").increment(1);
    }

    // Search priority: vector → optical → trigram text
    let results = {
        // 1. Vector search (semantic, requires EMBEDDING_BACKEND)
        let vec_results = retriever::vector_search(&state.db, payload.project_id, &payload.query).await;
        if let Some(r) = vec_results {
            if !r.is_empty() {
                counter!("ocr_memory_retrieve_path_total", "path" => "vector").increment(1);
                info!(count = r.len(), "vector search hit");
                r
            } else {
                optical_or_text(&state, payload.project_id, &payload.query).await
            }
        } else {
            optical_or_text(&state, payload.project_id, &payload.query).await
        }
    };

    cache_set(&state.cache, &cache_key, &results, CACHE_TTL_SECS).await;

    let n_results = results.len();
    let req_id_str = telemetry::request_id(&headers);
    fire_webhook("retrieve", payload.project_id, Uuid::nil(), n_results, req_id_str);

    let elapsed = start.elapsed().as_secs_f64();
    counter!("ocr_memory_retrieve_requests_total", "status" => "ok", "cache" => "miss").increment(1);
    histogram!("ocr_memory_retrieve_duration_seconds").record(elapsed);

    (StatusCode::OK, Json(results)).into_response()
}

async fn optical_or_text(state: &AppState, project_id: Uuid, query: &str) -> Vec<String> {
    if let Some(backend) = state.vision_backend {
        match optical_retrieve(&state.db, project_id, query, backend).await {
            Ok(r) if !r.is_empty() => {
                counter!("ocr_memory_retrieve_path_total", "path" => "optical").increment(1);
                info!(count = r.len(), "optical hit");
                r
            }
            Ok(_) => {
                warn!("optical empty, falling back to text");
                counter!("ocr_memory_retrieve_path_total", "path" => "text").increment(1);
                text_retrieve(&state.db, project_id, query).await
            }
            Err(e) => {
                warn!(error=%e, "optical failed, falling back to text");
                counter!("ocr_memory_retrieve_path_total", "path" => "text").increment(1);
                text_retrieve(&state.db, project_id, query).await
            }
        }
    } else {
        counter!("ocr_memory_retrieve_path_total", "path" => "text").increment(1);
        text_retrieve(&state.db, project_id, query).await
    }
}

// ── Cache helpers (Disk or Redis) ─────────────────────────────────────────────

async fn build_cache_key(cache: &CacheBackend, project_id: Uuid, query: &str) -> String {
    let version = match cache {
        CacheBackend::Disk(_) => "0".to_string(),
        CacheBackend::Redis(conn) => {
            let mut c = conn.clone();
            redis::cmd("GET")
                .arg(format!("version:{}", project_id))
                .query_async::<_, Option<String>>(&mut c)
                .await
                .unwrap_or(None)
                .unwrap_or_else(|| "0".to_string())
        }
    };
    format!("{}_{}_{}", project_id, version, query_hash(query))
}

async fn cache_get(cache: &CacheBackend, key: &str) -> Option<Vec<String>> {
    match cache {
        CacheBackend::Disk(dir) => {
            let path = dir.join(format!("{}.json", key));
            let content = std::fs::read_to_string(&path).ok()?;
            let entry: serde_json::Value = serde_json::from_str(&content).ok()?;
            let expires = entry["expires_at"].as_u64()?;
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH).ok()?.as_secs();
            if now > expires { std::fs::remove_file(path).ok(); return None; }
            serde_json::from_value(entry["value"].clone()).ok()
        }
        CacheBackend::Redis(conn) => {
            let mut c = conn.clone();
            let hit: Option<String> = redis::cmd("GET")
                .arg(key).query_async(&mut c).await.unwrap_or(None);
            hit.and_then(|s| serde_json::from_str(&s).ok())
        }
    }
}

async fn cache_set(cache: &CacheBackend, key: &str, value: &[String], ttl: u64) {
    match cache {
        CacheBackend::Disk(dir) => {
            let path = dir.join(format!("{}.json", key));
            let expires = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs() + ttl;
            let entry = serde_json::json!({ "expires_at": expires, "value": value });
            std::fs::write(path, entry.to_string()).ok();
            counter!("ocr_memory_redis_cache_operations_total", "op" => "set", "status" => "ok").increment(1);
        }
        CacheBackend::Redis(conn) => {
            if let Ok(json) = serde_json::to_string(value) {
                let mut c = conn.clone();
                let _: redis::RedisResult<()> = redis::cmd("SETEX")
                    .arg(key).arg(ttl).arg(json).query_async(&mut c).await;
                counter!("ocr_memory_redis_cache_operations_total", "op" => "set", "status" => "ok").increment(1);
            }
        }
    }
}

async fn cache_invalidate(cache: &CacheBackend, project_id: Uuid) {
    match cache {
        CacheBackend::Disk(dir) => {
            let prefix = project_id.to_string();
            if let Ok(entries) = std::fs::read_dir(dir) {
                for entry in entries.flatten() {
                    if entry.file_name().to_string_lossy().starts_with(&prefix) {
                        std::fs::remove_file(entry.path()).ok();
                    }
                }
            }
        }
        CacheBackend::Redis(conn) => {
            let mut c = conn.clone();
            let _: redis::RedisResult<i64> = redis::cmd("INCR")
                .arg(format!("version:{}", project_id))
                .query_async(&mut c).await;
        }
    }
}

// ── Optical retrieval ─────────────────────────────────────────────────────────

async fn optical_retrieve(
    pool: &sqlx::PgPool,
    project_id: Uuid,
    query: &str,
    backend: Backend,
) -> Result<Vec<String>, Box<dyn std::error::Error>> {
    let t = Instant::now();

    let memory = sqlx::query(
        "SELECT vm.episode_id, vm.image_path \
         FROM visual_memories vm \
         JOIN episodes e ON vm.episode_id = e.id \
         WHERE e.project_id = $1 \
         ORDER BY vm.created_at DESC LIMIT 1",
    )
    .bind(project_id)
    .fetch_optional(pool).await?;

    let Some(mem) = memory else { return Ok(vec![]); };

    let episode_id: Uuid = mem.try_get("episode_id")?;
    let image_path: String = mem.try_get("image_path")?;
    let image_bytes = std::fs::read(&image_path)
        .map_err(|e| format!("image read {}: {}", image_path, e))?;

    let (indices, input_tokens, output_tokens) =
        VisionClient::new().retrieve_indices_with_usage(&image_bytes, query, backend).await?;

    let bk = format!("{:?}", backend).to_lowercase();
    counter!("ocr_memory_vision_api_requests_total", "backend" => bk.clone(), "status" => "ok").increment(1);
    counter!("ocr_memory_vision_api_tokens_total", "backend" => bk.clone(), "direction" => "input").increment(input_tokens);
    counter!("ocr_memory_vision_api_tokens_total", "backend" => bk.clone(), "direction" => "output").increment(output_tokens);
    histogram!("ocr_memory_vision_api_duration_seconds", "backend" => bk).record(t.elapsed().as_secs_f64());

    if indices.is_empty() { return Ok(vec![]); }

    let logs = sqlx::query(
        "SELECT content FROM text_logs WHERE episode_id = $1 ORDER BY seq_index ASC",
    )
    .bind(episode_id)
    .fetch_all(pool).await?;

    Ok(indices.iter()
        .filter_map(|&i| logs.get((i as usize).saturating_sub(1)))
        .filter_map(|r| r.try_get::<String, _>("content").ok())
        .collect())
}

async fn text_retrieve(pool: &sqlx::PgPool, project_id: Uuid, query: &str) -> Vec<String> {
    VisionClient::new()
        .retrieve_project_context(pool, project_id, query)
        .await
        .unwrap_or_default()
}

// ── Background active recall ──────────────────────────────────────────────────

async fn sharpen_cold_memories(
    pool: &sqlx::PgPool,
    project_id: Uuid,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let cold = sqlx::query(
        "SELECT vm.episode_id, vm.image_path \
         FROM visual_memories vm \
         JOIN episodes e ON vm.episode_id = e.id \
         WHERE e.project_id = $1 AND vm.resolution_width < 1024",
    )
    .bind(project_id)
    .fetch_all(pool).await?;

    for mem in cold {
        let episode_id: Uuid = mem.try_get("episode_id")?;
        let image_path: String = mem.try_get("image_path")?;
        let logs = sqlx::query(
            "SELECT content FROM text_logs WHERE episode_id = $1 ORDER BY seq_index ASC",
        )
        .bind(episode_id)
        .fetch_all(pool).await?;

        let segments: Vec<String> = logs.into_iter()
            .map(|l| l.try_get::<String, _>("content").unwrap_or_default())
            .collect();
        let sharpened = TrajectoryRenderer::new().render_trajectory(segments, (1024, 1024));

        if std::fs::write(&image_path, &sharpened).is_ok() {
            sqlx::query(
                "UPDATE visual_memories SET resolution_width=1024, resolution_height=1024 \
                 WHERE episode_id=$1",
            )
            .bind(episode_id)
            .execute(pool).await?;
            info!(episode_id = %episode_id, "sharpened cold memory");
        }
    }
    Ok(())
}

// ── Webhook ───────────────────────────────────────────────────────────────────

fn fire_webhook(event: &'static str, project_id: Uuid, episode_id: Uuid, events_count: usize, req_id: String) {
    let url = match std::env::var("WEBHOOK_URL") {
        Ok(u) if !u.is_empty() => u,
        _ => return,
    };
    tokio::spawn(async move {
        let payload = serde_json::json!({
            "event":        event,
            "project_id":   project_id,
            "episode_id":   episode_id,
            "events_count": events_count,
            "timestamp":    chrono::Utc::now().to_rfc3339(),
            "req_id":       req_id,
        });
        let _ = reqwest::Client::new()
            .post(&url)
            .json(&payload)
            .timeout(std::time::Duration::from_secs(5))
            .send()
            .await;
    });
}

// ── Utilities ─────────────────────────────────────────────────────────────────

fn query_hash(query: &str) -> u64 {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    let mut h = DefaultHasher::new();
    query.hash(&mut h);
    h.finish()
}

// ── Rate limiting middleware ──────────────────────────────────────────────────

async fn rate_limit_middleware(
    state: State<Arc<AppState>>,
    request: axum::extract::Request,
    next: middleware::Next,
) -> axum::response::Response {
    let state = state.0;
    let rpm_limit: u32 = std::env::var("RATE_LIMIT_RPM")
        .ok().and_then(|v| v.parse().ok()).unwrap_or(60);

    // Key by raw X-Api-Key header (or "anonymous" if absent)
    let key = request.headers()
        .get("x-api-key")
        .or_else(|| request.headers().get("authorization"))
        .and_then(|v| v.to_str().ok())
        .unwrap_or("anonymous")
        .to_string();

    let now_secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);

    let count = {
        let mut limiter = state.rate_limiter.lock().await;

        // Prune stale entries every ~1000 requests to prevent unbounded growth
        if limiter.len() > 1000 {
            limiter.retain(|_, (_, window)| now_secs.saturating_sub(*window) < 120);
        }

        let entry = limiter.entry(key.clone()).or_insert((0, now_secs));
        if now_secs.saturating_sub(entry.1) >= 60 {
            entry.0 = 0;
            entry.1 = now_secs;
        }
        entry.0 += 1;
        entry.0
    };

    if count > rpm_limit {
        counter!("ocr_memory_rate_limited_total").increment(1);
        warn!(key = key.chars().take(8).collect::<String>(), count, rpm_limit, "rate limited");
        return (
            StatusCode::TOO_MANY_REQUESTS,
            [
                ("Retry-After", "60"),
                ("X-RateLimit-Limit", "60"),
                ("X-RateLimit-Reset", "60"),
            ],
            "Rate limit exceeded — max 60 requests/minute per key. Retry after 60 seconds.",
        ).into_response();
    }

    next.run(request).await
}

// ── Request-ID passthrough middleware ─────────────────────────────────────────

async fn req_id_middleware(
    request: axum::extract::Request,
    next: middleware::Next,
) -> axum::response::Response {
    let req_id = request
        .headers()
        .get("x-request-id")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("no-req-id")
        .to_string();

    let mut response = next.run(request).await;
    if let Ok(val) = req_id.parse::<axum::http::HeaderValue>() {
        response.headers_mut().insert("x-request-id", val);
    }
    response
}

// ── Retention policy ──────────────────────────────────────────────────────────

async fn retention_run(state: State<Arc<AppState>>) -> impl IntoResponse {
    let state = state.0;
    let ttl_days: Option<i64> = std::env::var("RETENTION_TTL_DAYS")
        .ok().and_then(|v| v.parse().ok()).filter(|&d: &i64| d > 0);
    let max_per_project: Option<i64> = std::env::var("RETENTION_MAX_EPISODES")
        .ok().and_then(|v| v.parse().ok()).filter(|&m: &i64| m > 0);
    let do_archive = std::env::var("RETENTION_ARCHIVE")
        .map(|v| v == "true" || v == "1").unwrap_or(false);

    if ttl_days.is_none() && max_per_project.is_none() {
        return (StatusCode::OK, Json(serde_json::json!({
            "message": "no retention policy configured",
            "deleted_episodes": 0,
            "freed_bytes": 0,
            "archived_pngs": 0,
        }))).into_response();
    }

    let mut victim_ids: Vec<Uuid> = Vec::new();

    if let Some(days) = ttl_days {
        let cutoff = chrono::Utc::now() - chrono::Duration::days(days);
        let rows = sqlx::query(
            "SELECT id FROM episodes WHERE created_at < $1 AND archived_at IS NULL",
        )
        .bind(cutoff)
        .fetch_all(&state.db).await.unwrap_or_default();
        victim_ids.extend(rows.into_iter().filter_map(|r| r.try_get::<Uuid, _>("id").ok()));
    }

    if let Some(max) = max_per_project {
        let projects = sqlx::query("SELECT DISTINCT project_id FROM episodes")
            .fetch_all(&state.db).await.unwrap_or_default();
        for p in projects {
            let project_id: Uuid = match p.try_get("project_id") {
                Ok(id) => id,
                Err(_) => continue,
            };
            let rows: Vec<Uuid> = sqlx::query_scalar(
                "SELECT id FROM episodes WHERE project_id = $1 AND archived_at IS NULL \
                 ORDER BY created_at ASC OFFSET $2"
            )
            .bind(project_id)
            .bind(max)
            .fetch_all(&state.db).await.unwrap_or_default();
            victim_ids.extend(rows);
        }
    }

    victim_ids.sort();
    victim_ids.dedup();

    let mut deleted: u64 = 0;
    let mut freed_bytes: u64 = 0;
    let mut archived_pngs: u64 = 0;

    for id in &victim_ids {
        let images = sqlx::query(
            "SELECT vm.image_path, e.project_id \
             FROM visual_memories vm JOIN episodes e ON vm.episode_id = e.id \
             WHERE vm.episode_id = $1",
        )
        .bind(id)
        .fetch_all(&state.db).await.unwrap_or_default();

        let image_paths: Vec<String> = images.iter()
            .filter_map(|img| img.try_get::<String, _>("image_path").ok())
            .collect();
        for img in &images {
            let image_path: String = img.try_get("image_path").unwrap_or_default();
            let project_id: Uuid = img.try_get("project_id").unwrap_or(Uuid::nil());
            let path = std::path::Path::new(&image_path);
            if do_archive {
                let dst = std::path::PathBuf::from(".vault/archive")
                    .join(project_id.to_string());
                std::fs::create_dir_all(&dst).ok();
                if let Some(fname) = path.file_name() {
                    if std::fs::copy(path, dst.join(fname)).is_ok() {
                        archived_pngs += 1;
                    }
                }
            }
            freed_bytes += std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
        }

        if sqlx::query("DELETE FROM episodes WHERE id = $1")
            .bind(id)
            .execute(&state.db).await.is_ok()
        {
            deleted += 1;
            for p in &image_paths {
                std::fs::remove_file(p).ok();
            }
        }
    }

    info!(deleted, freed_bytes, archived_pngs, "retention run complete");
    (StatusCode::OK, Json(serde_json::json!({
        "deleted_episodes": deleted,
        "freed_bytes": freed_bytes,
        "archived_pngs": archived_pngs,
    }))).into_response()
}
