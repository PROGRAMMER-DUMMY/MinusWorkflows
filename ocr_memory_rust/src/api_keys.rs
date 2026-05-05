use axum::{
    extract::State,
    http::StatusCode,
    middleware::Next,
    response::{IntoResponse, Response},
    Json,
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use sqlx::{PgPool, Row};
use std::{env, sync::Arc};
use uuid::Uuid;

use crate::state::AppState;

// ── Audit log (best-effort, non-blocking) ─────────────────────────────────────

pub fn audit(pool: &PgPool, key_id: Option<Uuid>, action: &'static str, project_id: Option<Uuid>, req_id: Option<&str>, status: &'static str, meta: Option<serde_json::Value>) {
    let pool = pool.clone();
    let req_id = req_id.map(str::to_string);
    let meta_val = meta;
    tokio::spawn(async move {
        let _ = sqlx::query(
            "INSERT INTO audit_log (key_id, action, project_id, req_id, status, meta) \
             VALUES ($1, $2, $3, $4, $5, $6)"
        )
        .bind(key_id)
        .bind(action)
        .bind(project_id)
        .bind(req_id)
        .bind(status)
        .bind(meta_val)
        .execute(&pool)
        .await;
    });
}

// ── Key resolution (injected into request extensions by middleware) ────────────

#[derive(Clone, Debug)]
pub struct ResolvedKey {
    pub key_id:     Uuid,
    pub project_id: Option<Uuid>,  // None = global (admin) key
    pub label:      String,
}

// ── Middleware ────────────────────────────────────────────────────────────────

/// Per-project API key auth middleware.
/// Accepts X-Api-Key or Authorization: Bearer.
/// Resolves the key against the api_keys table, enforces expiry,
/// and injects a ResolvedKey extension for downstream handlers.
///
/// Backward compat: if API_KEY env is set and no DB row matches,
/// falls back to comparing the raw key string (global dev key).
pub async fn auth_middleware(
    state: State<Arc<AppState>>,
    mut request: axum::extract::Request,
    next: Next,
) -> Response {
    let state = state.0;
    let headers = request.headers();
    let provided = headers
        .get("x-api-key")
        .and_then(|v| v.to_str().ok())
        .or_else(|| {
            headers
                .get("authorization")
                .and_then(|v| v.to_str().ok())
                .and_then(|s| s.strip_prefix("Bearer "))
        });

    let raw_key = match provided {
        Some(k) => k.to_string(),
        None => {
            return (
                StatusCode::UNAUTHORIZED,
                Json(json!({"error": "unauthorized", "hint": "set X-Api-Key header"})),
            )
                .into_response();
        }
    };

    // Try DB lookup first
    if let Some(resolved) = lookup_key(&state.db, &raw_key).await {
        request.extensions_mut().insert(resolved);
        return next.run(request).await;
    }

    // Backward compat: env API_KEY fallback (global, no project scope)
    if let Some(ref env_key) = state.api_key {
        if raw_key == *env_key {
            request.extensions_mut().insert(ResolvedKey {
                key_id:     Uuid::nil(),
                project_id: None,
                label:      "env-global".to_string(),
            });
            return next.run(request).await;
        }
    }

    (
        StatusCode::UNAUTHORIZED,
        Json(json!({"error": "unauthorized", "hint": "invalid or expired API key"})),
    )
        .into_response()
}

/// Project-scope enforcer — call after auth_middleware on endpoints that accept project_id.
/// Rejects requests where the key's project_id doesn't match the body's project_id.
pub fn enforce_project_scope(resolved: &ResolvedKey, request_project_id: Uuid) -> Result<(), Response> {
    match resolved.project_id {
        None => Ok(()), // global key — access to all projects
        Some(scoped) if scoped == request_project_id => Ok(()),
        Some(scoped) => Err((
            StatusCode::FORBIDDEN,
            Json(json!({
                "error": "forbidden",
                "hint": format!("this key is scoped to project {}", scoped)
            })),
        )
            .into_response()),
    }
}

// ── DB helpers ────────────────────────────────────────────────────────────────

fn hash_key(raw: &str) -> String {
    let mut h = Sha256::new();
    h.update(raw.as_bytes());
    hex::encode(h.finalize())
}

async fn lookup_key(pool: &PgPool, raw_key: &str) -> Option<ResolvedKey> {
    let hash = hash_key(raw_key);

    let row = sqlx::query(
        "SELECT id, project_id, label, expires_at FROM api_keys WHERE key_hash = $1",
    )
    .bind(hash)
    .fetch_optional(pool)
    .await
    .ok()??;

    let expires_at: Option<chrono::DateTime<chrono::Utc>> = row.try_get("expires_at").unwrap_or(None);
    if let Some(expires) = expires_at {
        if expires < chrono::Utc::now() {
            return None;
        }
    }

    let id: Uuid = row.try_get("id").ok()?;
    let project_id: Option<Uuid> = row.try_get("project_id").unwrap_or(None);
    let label: String = row.try_get("label").ok()?;

    let pool2 = pool.clone();
    tokio::spawn(async move {
        let _ = sqlx::query("UPDATE api_keys SET last_used_at = now() WHERE id = $1")
            .bind(id)
            .execute(&pool2)
            .await;
    });
    audit(pool, Some(id), "use", project_id, None, "ok", None);

    Some(ResolvedKey { key_id: id, project_id, label })
}

// ── Management endpoints ──────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct CreateKeyRequest {
    pub project_id:      Option<Uuid>,
    pub label:           String,
    pub expires_in_days: Option<i64>,
}

#[derive(Serialize)]
struct CreateKeyResponse {
    id:         Uuid,
    raw_key:    String,  // shown once, never stored
    project_id: Option<Uuid>,
    label:      String,
    expires_at: Option<String>,
}

pub async fn create_key(
    state: State<Arc<AppState>>,
    req: Json<CreateKeyRequest>,
) -> impl IntoResponse {
    let state = state.0;
    let req = req.0;
    let raw_key = format!("mk_{}", Uuid::new_v4().to_string().replace('-', ""));
    let hash = hash_key(&raw_key);

    let expires_at = req.expires_in_days.map(|d| {
        chrono::Utc::now() + chrono::Duration::days(d)
    });

    let row = sqlx::query(
        "INSERT INTO api_keys (key_hash, project_id, label, expires_at) \
         VALUES ($1, $2, $3, $4) RETURNING id",
    )
    .bind(hash)
    .bind(req.project_id)
    .bind(req.label.clone())
    .bind(expires_at)
    .fetch_one(&state.db)
    .await;

    match row {
        Ok(r) => {
            let id: Uuid = r.try_get("id").expect("RETURNING id");
            audit(&state.db, Some(id), "create", req.project_id, None, "ok",
                Some(json!({ "label": req.label })));
            (
                StatusCode::CREATED,
                Json(json!(CreateKeyResponse {
                    id,
                    raw_key,
                    project_id: req.project_id,
                    label: req.label,
                    expires_at: expires_at.map(|e| e.to_rfc3339()),
                })),
            )
                .into_response()
        }
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
}

pub async fn revoke_key(
    state: State<Arc<AppState>>,
    id: axum::extract::Path<Uuid>,
) -> impl IntoResponse {
    let state = state.0;
    let id = id.0;
    let result = sqlx::query(
        "DELETE FROM api_keys WHERE id = $1 RETURNING id, project_id",
    )
    .bind(id)
    .fetch_optional(&state.db)
    .await;

    match result {
        Ok(Some(r)) => {
            let project_id: Option<Uuid> = r.try_get("project_id").unwrap_or(None);
            audit(&state.db, Some(id), "revoke", project_id, None, "ok", None);
            StatusCode::NO_CONTENT.into_response()
        }
        Ok(None)    => (StatusCode::NOT_FOUND, "key not found").into_response(),
        Err(e)      => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
}

pub async fn rotate_key(
    state: State<Arc<AppState>>,
    id: axum::extract::Path<Uuid>,
) -> impl IntoResponse {
    let state = state.0;
    let id = id.0;
    let existing = sqlx::query(
        "SELECT project_id, label FROM api_keys WHERE id = $1",
    )
    .bind(id)
    .fetch_optional(&state.db)
    .await;

    match existing {
        Ok(Some(row)) => {
            let project_id: Option<Uuid> = row.try_get("project_id").unwrap_or(None);
            let label: String = row.try_get("label").unwrap_or_default();
            let raw_key = format!("mk_{}", Uuid::new_v4().to_string().replace('-', ""));
            let new_hash = hash_key(&raw_key);

            let result = sqlx::query(
                "UPDATE api_keys SET key_hash = $1, last_used_at = NULL WHERE id = $2",
            )
            .bind(new_hash)
            .bind(id)
            .execute(&state.db)
            .await;

            match result {
                Ok(_) => {
                    let rotated_at = chrono::Utc::now().to_rfc3339();
                    audit(&state.db, Some(id), "rotate", project_id, None, "ok",
                        Some(json!({ "label": label })));
                    (StatusCode::OK, Json(json!({
                        "id": id,
                        "raw_key": raw_key,
                        "project_id": project_id,
                        "label": label,
                        "rotated_at": rotated_at,
                    }))).into_response()
                }
                Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
            }
        }
        Ok(None) => (StatusCode::NOT_FOUND, "key not found").into_response(),
        Err(e)   => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
}

#[derive(Serialize)]
struct KeyRecord {
    id:           Uuid,
    project_id:   Option<Uuid>,
    label:        String,
    created_at:   String,
    expires_at:   Option<String>,
    last_used_at: Option<String>,
}

pub async fn list_keys(state: State<Arc<AppState>>) -> impl IntoResponse {
    let state = state.0;
    let rows = sqlx::query(
        "SELECT id, project_id, label, created_at, expires_at, last_used_at \
         FROM api_keys ORDER BY created_at DESC",
    )
    .fetch_all(&state.db)
    .await;

    match rows {
        Ok(rs) => {
            let keys: Vec<KeyRecord> = rs.into_iter().map(|r| KeyRecord {
                id:           r.try_get("id").unwrap_or(Uuid::nil()),
                project_id:   r.try_get("project_id").unwrap_or(None),
                label:        r.try_get("label").unwrap_or_default(),
                created_at:   r.try_get::<chrono::DateTime<chrono::Utc>, _>("created_at")
                               .map(|t| t.to_rfc3339()).unwrap_or_default(),
                expires_at:   r.try_get::<Option<chrono::DateTime<chrono::Utc>>, _>("expires_at")
                               .unwrap_or(None).map(|t| t.to_rfc3339()),
                last_used_at: r.try_get::<Option<chrono::DateTime<chrono::Utc>>, _>("last_used_at")
                               .unwrap_or(None).map(|t| t.to_rfc3339()),
            }).collect();
            (StatusCode::OK, Json(json!(keys))).into_response()
        }
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
}

// ── Audit log query ───────────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct AuditQueryParams {
    pub limit:  Option<i64>,
    pub key_id: Option<Uuid>,
    pub action: Option<String>,
    pub since:  Option<String>,  // ISO 8601 — filter rows created_at >= since
}

pub async fn list_audit(
    state: State<Arc<AppState>>,
    params: axum::extract::Query<AuditQueryParams>,
) -> impl IntoResponse {
    let state = state.0;
    let params = params.0;
    let limit = params.limit.unwrap_or(100).min(1000);
    let since = params.since
        .as_deref()
        .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
        .map(|dt| dt.with_timezone(&chrono::Utc));

    let rows = sqlx::query(
        "SELECT id, key_id, action, project_id, req_id, status, meta, created_at \
         FROM audit_log \
         WHERE ($1::UUID IS NULL OR key_id = $1) \
           AND ($2::TEXT IS NULL OR action = $2) \
           AND ($3::TIMESTAMPTZ IS NULL OR created_at >= $3) \
         ORDER BY created_at DESC LIMIT $4",
    )
    .bind(params.key_id)
    .bind(params.action.as_deref())
    .bind(since)
    .bind(limit)
    .fetch_all(&state.db)
    .await;

    match rows {
        Ok(rs) => {
            let out: Vec<serde_json::Value> = rs.into_iter().map(|r| json!({
                "id":         r.try_get::<Uuid, _>("id").ok(),
                "key_id":     r.try_get::<Option<Uuid>, _>("key_id").unwrap_or(None),
                "action":     r.try_get::<String, _>("action").unwrap_or_default(),
                "project_id": r.try_get::<Option<Uuid>, _>("project_id").unwrap_or(None),
                "req_id":     r.try_get::<Option<String>, _>("req_id").unwrap_or(None),
                "status":     r.try_get::<String, _>("status").unwrap_or_default(),
                "meta":       r.try_get::<Option<serde_json::Value>, _>("meta").unwrap_or(None),
                "created_at": r.try_get::<chrono::DateTime<chrono::Utc>, _>("created_at")
                               .map(|t| t.to_rfc3339()).ok(),
            })).collect();
            (StatusCode::OK, Json(json!(out))).into_response()
        }
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
}

// ── Admin key guard ───────────────────────────────────────────────────────────

/// Middleware for /keys/* and /admin/* — requires ADMIN_KEY env var.
pub async fn admin_auth_middleware(
    request: axum::extract::Request,
    next: Next,
) -> Response {
    let admin_key = env::var("ADMIN_KEY").unwrap_or_default();
    if admin_key.is_empty() {
        return (StatusCode::SERVICE_UNAVAILABLE,
                Json(json!({"error": "ADMIN_KEY not configured"}))).into_response();
    }

    let headers = request.headers();
    let provided = headers
        .get("x-admin-key")
        .or_else(|| headers.get("x-api-key"))
        .and_then(|v| v.to_str().ok());

    if provided != Some(admin_key.as_str()) {
        return (StatusCode::UNAUTHORIZED,
                Json(json!({"error": "invalid admin key"}))).into_response();
    }

    next.run(request).await
}
