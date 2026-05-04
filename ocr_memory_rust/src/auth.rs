use axum::{
    extract::State,
    http::StatusCode,
    middleware::Next,
    response::{IntoResponse, Response},
    Json,
};
use serde_json::json;
use std::sync::Arc;

use crate::state::AppState;

/// Checks X-Api-Key or Authorization: Bearer <key> on protected routes.
/// If API_KEY is not set in the environment, auth is skipped (dev mode).
pub async fn auth_middleware(
    state: State<Arc<AppState>>,
    request: axum::extract::Request,
    next: Next,
) -> Response {
    let state = state.0;
    if let Some(expected) = &state.api_key {
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

        if provided != Some(expected.as_str()) {
            return (
                StatusCode::UNAUTHORIZED,
                Json(json!({"error": "unauthorized", "hint": "set X-Api-Key header"})),
            )
                .into_response();
        }
    }

    next.run(request).await
}
