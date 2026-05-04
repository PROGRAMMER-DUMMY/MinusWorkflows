use axum::{
    extract::State,
    http::StatusCode,
    middleware::Next,
    response::{IntoResponse, Response},
    Extension, Json,
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use sqlx::PgPool;
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
    State(state): State<Arc<AppState>>,
    mut request: axum::extract::Request,
    next: Next,
) -> Response {
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

    let row = sqlx::query!(
        "SELECT id, project_id, label, expires_at FROM api_keys WHERE key_hash = $1",
        hash
    )
    .fetch_optional(pool)
    .await
    .ok()??;

    // Check expiry
    if let Some(expires) = row.expires_at {
        if expires < chrono::Utc::now() {
            return None;
        }
    }

    // Update last_used_at and write audit entry (best-effort, non-blocking)
    let pool2 = pool.clone();
    let id = row.id;
    let project_id_for_audit = row.project_id;
    tokio::spawn(async move {
        let _ = sqlx::query!("UPDATE api_keys SET last_used_at = now() WHERE id = $1", id)
            .execute(&pool2)
            .await;
    });
    audit(pool, Some(id), "use", project_id_for_audit, None, "ok", None);

    Some(ResolvedKey {
        key_id:     row.id,
        project_id: row.project_id,
        label:      row.label,
    })
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
    State(state): State<Arc<AppState>>,
    Json(req): Json<CreateKeyRequest>,
) -> impl IntoResponse {
    let raw_key = format!("mk_{}", Uuid::new_v4().to_string().replace('-', ""));
    let hash = hash_key(&raw_key);

    let expires_at = req.expires_in_days.map(|d| {
        chrono::Utc::now() + chrono::Duration::days(d)
    });

    let row = sqlx::query!(
        "INSERT INTO api_keys (key_hash, project_id, label, expires_at) \
         VALUES ($1, $2, $3, $4) RETURNING id",
        hash,
        req.project_id,
        req.label,
        expires_at,
    )
    .fetch_one(&state.db)
    .await;

    match row {
        Ok(r) => {
            audit(&state.db, Some(r.id), "create", req.project_id, None, "ok",
                Some(json!({ "label": req.label })));
            (
                StatusCode::CREATED,
                Json(json!(CreateKeyResponse {
                    id: r.id,
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
    State(state): State<Arc<AppState>>,
    axum::extract::Path(id): axum::extract::Path<Uuid>,
) -> impl IntoResponse {
    let result = sqlx::query!("DELETE FROM api_keys WHERE id = $1 RETURNING id, project_id", id)
        .fetch_optional(&state.db)
        .await;

    match result {
        Ok(Some(r)) => {
            audit(&state.db, Some(id), "revoke", r.project_id, None, "ok", None);
            StatusCode::NO_CONTENT.into_response()
        }
        Ok(None)    => (StatusCode::NOT_FOUND, "key not found").into_response(),
        Err(e)      => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
}

pub async fn rotate_key(
    State(state): State<Arc<AppState>>,
    axum::extract::Path(id): axum::extract::Path<Uuid>,
) -> impl IntoResponse {
    let existing = sqlx::query!(
        "SELECT project_id, label FROM api_keys WHERE id = $1",
        id
    )
    .fetch_optional(&state.db)
    .await;

    match existing {
        Ok(Some(row)) => {
            let raw_key = format!("mk_{}", Uuid::new_v4().to_string().replace('-', ""));
            let new_hash = hash_key(&raw_key);

            let result = sqlx::query!(
                "UPDATE api_keys SET key_hash = $1, last_used_at = NULL WHERE id = $2",
                new_hash, id
            )
            .execute(&state.db)
            .await;

            match result {
                Ok(_) => {
                    let rotated_at = chrono::Utc::now().to_rfc3339();
                    audit(&state.db, Some(id), "rotate", row.project_id, None, "ok",
                        Some(json!({ "label": row.label })));
                    (StatusCode::OK, Json(json!({
                        "id": id,
                        "raw_key": raw_key,
                        "project_id": row.project_id,
                        "label": row.label,
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

pub async fn list_keys(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    let rows = sqlx::query!(
        "SELECT id, project_id, label, created_at, expires_at, last_used_at \
         FROM api_keys ORDER BY created_at DESC"
    )
    .fetch_all(&state.db)
    .await;

    match rows {
        Ok(rs) => {
            let keys: Vec<KeyRecord> = rs.into_iter().map(|r| KeyRecord {
                id:           r.id,
                project_id:   r.project_id,
                label:        r.label,
                created_at:   r.created_at.to_rfc3339(),
                expires_at:   r.expires_at.map(|t| t.to_rfc3339()),
                last_used_at: r.last_used_at.map(|t| t.to_rfc3339()),
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
    State(state): State<Arc<AppState>>,
    axum::extract::Query(params): axum::extract::Query<AuditQueryParams>,
) -> impl IntoResponse {
    let limit = params.limit.unwrap_or(100).min(1000);
    let since = params.since
        .as_deref()
        .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
        .map(|dt| dt.with_timezone(&chrono::Utc));

    let rows = sqlx::query!(
        "SELECT id, key_id, action, project_id, req_id, status, meta, created_at \
         FROM audit_log \
         WHERE ($1::UUID IS NULL OR key_id = $1) \
           AND ($2::TEXT IS NULL OR action = $2) \
           AND ($3::TIMESTAMPTZ IS NULL OR created_at >= $3) \
         ORDER BY created_at DESC LIMIT $4",
        params.key_id,
        params.action.as_deref(),
        since,
        limit,
    )
    .fetch_all(&state.db)
    .await;

    match rows {
        Ok(rs) => {
            let out: Vec<serde_json::Value> = rs.into_iter().map(|r| json!({
                "id":         r.id,
                "key_id":     r.key_id,
                "action":     r.action,
                "project_id": r.project_id,
                "req_id":     r.req_id,
                "status":     r.status,
                "meta":       r.meta,
                "created_at": r.created_at.to_rfc3339(),
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
