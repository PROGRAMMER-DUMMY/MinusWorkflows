use reqwest::Client;
use serde_json::json;
use std::env;

/// Embed text using the configured EMBEDDING_BACKEND.
/// Returns None if no backend is configured or if the call fails (callers degrade gracefully).
pub async fn embed_text(text: &str) -> Option<Vec<f32>> {
    let backend = env::var("EMBEDDING_BACKEND").unwrap_or_default().to_lowercase();
    match backend.as_str() {
        "openai" => embed_openai(text).await,
        _ => None,
    }
}

async fn embed_openai(text: &str) -> Option<Vec<f32>> {
    let api_key = env::var("OPENAI_API_KEY").ok()?;
    let model = env::var("EMBEDDING_MODEL")
        .unwrap_or_else(|_| "text-embedding-3-small".to_string());

    let client = Client::new();
    let resp = client
        .post("https://api.openai.com/v1/embeddings")
        .bearer_auth(&api_key)
        .json(&json!({ "model": model, "input": text }))
        .send()
        .await
        .ok()?;

    if !resp.status().is_success() {
        tracing::warn!(status = %resp.status(), "embedding API error");
        return None;
    }

    let body: serde_json::Value = resp.json().await.ok()?;

    // Track token usage in Prometheus
    if let Some(tokens) = body["usage"]["total_tokens"].as_u64() {
        metrics::counter!("ocr_memory_embedding_tokens_total", "backend" => "openai")
            .increment(tokens);
    }

    let arr = body["data"][0]["embedding"].as_array()?;
    let vec: Vec<f32> = arr
        .iter()
        .filter_map(|v| v.as_f64().map(|f| f as f32))
        .collect();

    if vec.is_empty() { None } else { Some(vec) }
}
