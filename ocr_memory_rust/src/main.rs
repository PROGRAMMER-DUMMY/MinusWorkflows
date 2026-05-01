mod db;
mod state;
mod retriever;
mod renderer;
mod scrubber;

use axum::{
    routing::{get, post},
    extract::State,
    Json,
    Router,
    response::IntoResponse,
    http::StatusCode,
};
use state::{init_state, AppState};
use std::sync::Arc;
use serde::Deserialize;
use uuid::Uuid;
use crate::renderer::TrajectoryRenderer;
use crate::retriever::VisionClient;

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
    #[allow(dead_code)]
    scope: String,
}

#[tokio::main]
async fn main() {
    // Initialize state (DB pool, Redis client, and SmartScrubber)
    let state = Arc::new(init_state().await);

    // Build our application with routes and state
    let app = Router::new()
        .route("/health", get(health_check))
        .route("/memory/store", post(store_memory))
        .route("/memory/retrieve", post(retrieve_memory))
        .with_state(state);

    // Run it with tokio on localhost:3000
    let listener = tokio::net::TcpListener::bind("127.0.0.1:3000").await.unwrap();
    println!("listening on {}", listener.local_addr().unwrap());
    axum::serve(listener, app).await.unwrap();
}

async fn health_check() -> &'static str {
    "OK"
}

async fn store_memory(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<StoreRequest>,
) -> impl IntoResponse {
    // 1. Ensure episode exists (Upsert)
    let res = sqlx::query(
        "INSERT INTO episodes (id, project_id, team_id, user_id, name) \
         VALUES ($1, $2, $3, $4, $5) \
         ON CONFLICT (id) DO NOTHING"
    )
    .bind(payload.episode_id)
    .bind(payload.project_id)
    .bind(payload.team_id)
    .bind(payload.user_id)
    .bind("Episode ".to_string() + &payload.episode_id.to_string())
    .execute(&state.db)
    .await;

    if let Err(e) = res {
        eprintln!("[FAIL] Failed to upsert episode: {}", e);
        return (StatusCode::INTERNAL_SERVER_ERROR, "Database error").into_response();
    }

    let scrubbed_events: Vec<String> = payload.events.iter()
        .map(|e| state.scrubber.scrub(e))
        .collect();

    // 2. Render and Save Image
    let renderer = TrajectoryRenderer::new();
    let width = 1024;
    let height = 1024;
    let image_bytes = renderer.render_trajectory(scrubbed_events.clone(), (width, height));

    let image_dir = "memory_bank";
    let _ = std::fs::create_dir_all(image_dir);
    let image_path = format!("{}/{}.png", image_dir, payload.episode_id);
    
    if let Err(e) = std::fs::write(&image_path, &image_bytes) {
        eprintln!("[FAIL] Failed to save image: {}", e);
        return (StatusCode::INTERNAL_SERVER_ERROR, "File system error").into_response();
    }

    // 3. Store Visual Memory metadata
    let res = sqlx::query(
        "INSERT INTO visual_memories (episode_id, image_path, resolution_width, resolution_height) \
         VALUES ($1, $2, $3, $4)"
    )
    .bind(payload.episode_id)
    .bind(&image_path)
    .bind(width as i32)
    .bind(height as i32)
    .execute(&state.db)
    .await;

    if let Err(e) = res {
        eprintln!("[FAIL] Failed to store visual memory: {}", e);
        return (StatusCode::INTERNAL_SERVER_ERROR, "Database error").into_response();
    }

    for event in &scrubbed_events {
        let res = sqlx::query(
            "INSERT INTO text_logs (project_id, team_id, user_id, episode_id, content) VALUES ($1, $2, $3, $4, $5)"
        )
        .bind(payload.project_id)
        .bind(payload.team_id)
        .bind(payload.user_id)
        .bind(payload.episode_id)
        .bind(event)
        .execute(&state.db)
        .await;

        if let Err(e) = res {
            eprintln!("[FAIL] Failed to store event: {}", e);
            return (StatusCode::INTERNAL_SERVER_ERROR, "Database error").into_response();
        }
    }

    StatusCode::OK.into_response()
}

async fn retrieve_memory(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<RetrieveRequest>,
) -> impl IntoResponse {
    // 1. Check for Active Recall (Promotion from Cold to Hot)
    let cold_memories = sqlx::query!(
        "SELECT vm.episode_id, vm.image_path FROM visual_memories vm \
         JOIN episodes e ON vm.episode_id = e.id \
         WHERE e.project_id = $1 AND vm.resolution_width < 1024",
        payload.project_id
    )
    .fetch_all(&state.db)
    .await;

    if let Ok(mems) = cold_memories {
        for mem in mems {
            println!("[RECALL] Sharpening cold memory for episode: {}", mem.episode_id);
            // Fetch original logs to re-render
            let logs = sqlx::query!(
                "SELECT content FROM text_logs WHERE episode_id = $1 ORDER BY created_at ASC",
                mem.episode_id
            )
            .fetch_all(&state.db)
            .await;

            if let Ok(l) = logs {
                let segments: Vec<String> = l.into_iter().map(|log| log.content).collect();
                let renderer = TrajectoryRenderer::new();
                let sharpened_bytes = renderer.render_trajectory(segments, (1024, 1024));
                
                if std::fs::write(&mem.image_path, sharpened_bytes).is_ok() {
                    let _ = sqlx::query!(
                        "UPDATE visual_memories SET resolution_width = 1024, resolution_height = 1024 \
                         WHERE episode_id = $1",
                        mem.episode_id
                    )
                    .execute(&state.db)
                    .await;
                }
            }
        }
    }

    let vision_client = VisionClient::new();
    
    match vision_client.retrieve_project_context(&state.db, payload.project_id, &payload.query).await {
        Ok(context) => (StatusCode::OK, Json(context)).into_response(),
        Err(e) => {
            eprintln!("[FAIL] Failed to retrieve context: {}", e);
            (StatusCode::INTERNAL_SERVER_ERROR, "Retrieval error").into_response()
        }
    }
}
