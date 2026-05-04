use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::env;
use base64::{Engine as _, engine::general_purpose};
use sqlx::{PgPool, Row};
use uuid::Uuid;

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub enum Backend {
    OpenAI,
    Anthropic,
    Google,
}

pub struct VisionClient {
    client: Client,
}

impl VisionClient {
    pub fn new() -> Self {
        Self { client: Client::new() }
    }

    /// Returns (indices, input_tokens, output_tokens).
    pub async fn retrieve_indices_with_usage(
        &self,
        image_bytes: &[u8],
        query: &str,
        backend: Backend,
    ) -> Result<(Vec<u32>, u64, u64), Box<dyn std::error::Error>> {
        let base64_image = general_purpose::STANDARD.encode(image_bytes);
        let mime_type = match image::guess_format(image_bytes) {
            Ok(image::ImageFormat::Png)  => "image/png",
            Ok(image::ImageFormat::Jpeg) => "image/jpeg",
            Ok(image::ImageFormat::Gif)  => "image/gif",
            Ok(image::ImageFormat::WebP) => "image/webp",
            _ => "image/jpeg",
        };
        match backend {
            Backend::OpenAI    => self.query_openai(&base64_image, query, mime_type).await,
            Backend::Anthropic => self.query_anthropic(&base64_image, query, mime_type).await,
            Backend::Google    => self.query_google(&base64_image, query, mime_type).await,
        }
    }

    /// Kept for backward compatibility — callers that don't need token counts.
    pub async fn retrieve_indices(
        &self,
        image_bytes: &[u8],
        query: &str,
        backend: Backend,
    ) -> Result<Vec<u32>, Box<dyn std::error::Error>> {
        let (indices, _, _) = self.retrieve_indices_with_usage(image_bytes, query, backend).await?;
        Ok(indices)
    }

    /// Trigram / ILIKE text fallback — used when no embedding backend is configured.
    pub async fn retrieve_project_context(
        &self,
        pool: &PgPool,
        project_id: Uuid,
        query: &str,
    ) -> Result<Vec<String>, Box<dyn std::error::Error>> {
        let logs = sqlx::query(
            "SELECT content FROM text_logs \
             WHERE project_id = $1 \
             AND (content ILIKE $2 OR content % $3) \
             ORDER BY created_at DESC LIMIT 50",
        )
        .bind(project_id)
        .bind(format!("%{}%", query))
        .bind(query)
        .fetch_all(pool)
        .await?;

        Ok(logs.into_iter().map(|l| l.try_get::<String, _>("content").unwrap_or_default()).collect())
    }

    async fn query_openai(
        &self,
        base64_image: &str,
        query: &str,
        mime_type: &str,
    ) -> Result<(Vec<u32>, u64, u64), Box<dyn std::error::Error>> {
        let api_key = env::var("OPENAI_API_KEY").map_err(|_| "OPENAI_API_KEY not set")?;
        let model = env::var("VISION_MODEL_OPENAI")
            .unwrap_or_else(|_| "gpt-4o".to_string());

        let resp = self.client
            .post("https://api.openai.com/v1/chat/completions")
            .bearer_auth(api_key)
            .json(&json!({
                "model": model,
                "messages": [{
                    "role": "user",
                    "content": [
                        { "type": "text", "text": format!(
                            "Identify the indices of items in the image matching: {}. Return only a JSON list e.g. [1, 3, 7].", query
                        )},
                        { "type": "image_url", "image_url": {
                            "url": format!("data:{};base64,{}", mime_type, base64_image)
                        }}
                    ]
                }],
                "max_tokens": 300
            }))
            .send()
            .await?;

        if !resp.status().is_success() {
            return Err(format!("OpenAI error: {}", resp.text().await?).into());
        }

        let body: serde_json::Value = resp.json().await?;
        let content = body["choices"][0]["message"]["content"]
            .as_str()
            .ok_or("Failed to parse OpenAI response")?;

        let input_tokens  = body["usage"]["prompt_tokens"].as_u64().unwrap_or(0);
        let output_tokens = body["usage"]["completion_tokens"].as_u64().unwrap_or(0);

        Ok((parse_indices(content)?, input_tokens, output_tokens))
    }

    async fn query_anthropic(
        &self,
        base64_image: &str,
        query: &str,
        mime_type: &str,
    ) -> Result<(Vec<u32>, u64, u64), Box<dyn std::error::Error>> {
        let api_key = env::var("ANTHROPIC_API_KEY").map_err(|_| "ANTHROPIC_API_KEY not set")?;
        let model = env::var("VISION_MODEL_ANTHROPIC")
            .unwrap_or_else(|_| "claude-sonnet-4-6".to_string());

        let resp = self.client
            .post("https://api.anthropic.com/v1/messages")
            .header("x-api-key", &api_key)
            .header("anthropic-version", "2023-06-01")
            .json(&json!({
                "model": model,
                "max_tokens": 1024,
                "messages": [{
                    "role": "user",
                    "content": [
                        { "type": "image", "source": {
                            "type": "base64",
                            "media_type": mime_type,
                            "data": base64_image
                        }},
                        { "type": "text", "text": format!(
                            "Identify the indices of items in the image matching: {}. Return only a JSON list e.g. [1, 3, 7].", query
                        )}
                    ]
                }]
            }))
            .send()
            .await?;

        if !resp.status().is_success() {
            return Err(format!("Anthropic error: {}", resp.text().await?).into());
        }

        let body: serde_json::Value = resp.json().await?;
        let content = body["content"][0]["text"]
            .as_str()
            .ok_or("Failed to parse Anthropic response")?;

        let input_tokens  = body["usage"]["input_tokens"].as_u64().unwrap_or(0);
        let output_tokens = body["usage"]["output_tokens"].as_u64().unwrap_or(0);

        Ok((parse_indices(content)?, input_tokens, output_tokens))
    }

    async fn query_google(
        &self,
        base64_image: &str,
        query: &str,
        mime_type: &str,
    ) -> Result<(Vec<u32>, u64, u64), Box<dyn std::error::Error>> {
        let api_key = env::var("GOOGLE_API_KEY").map_err(|_| "GOOGLE_API_KEY not set")?;
        let url = format!(
            "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key={}",
            api_key
        );

        let resp = self.client
            .post(url)
            .json(&json!({
                "contents": [{
                    "parts": [
                        { "text": format!(
                            "Identify the indices of items in the image matching: {}. Return only a JSON list e.g. [1, 3, 7].", query
                        )},
                        { "inline_data": { "mime_type": mime_type, "data": base64_image }}
                    ]
                }]
            }))
            .send()
            .await?;

        if !resp.status().is_success() {
            return Err(format!("Google error: {}", resp.text().await?).into());
        }

        let body: serde_json::Value = resp.json().await?;
        let content = body["candidates"][0]["content"]["parts"][0]["text"]
            .as_str()
            .ok_or("Failed to parse Google response")?;

        let input_tokens  = body["usageMetadata"]["promptTokenCount"].as_u64().unwrap_or(0);
        let output_tokens = body["usageMetadata"]["candidatesTokenCount"].as_u64().unwrap_or(0);

        Ok((parse_indices(content)?, input_tokens, output_tokens))
    }
}

/// Real vector search via pgvector cosine distance.
/// Returns None if EMBEDDING_BACKEND is not configured (caller should fall back).
pub async fn vector_search(
    pool: &PgPool,
    project_id: Uuid,
    query: &str,
) -> Option<Vec<String>> {
    let embedding_vec = crate::embedder::embed_text(query).await?;
    let embedding = pgvector::Vector::from(embedding_vec);

    let episode_rows = sqlx::query(
        "SELECT id FROM episodes \
         WHERE project_id = $1 AND embedding IS NOT NULL \
         ORDER BY embedding <=> $2 \
         LIMIT 5",
    )
    .bind(project_id)
    .bind(&embedding)
    .fetch_all(pool)
    .await
    .ok()?;

    if episode_rows.is_empty() {
        return Some(vec![]);
    }

    let mut results = Vec::new();
    for row in &episode_rows {
        let episode_id: Uuid = row.try_get("id").ok()?;
        let logs = sqlx::query(
            "SELECT content FROM text_logs WHERE episode_id = $1 ORDER BY seq_index ASC",
        )
        .bind(episode_id)
        .fetch_all(pool)
        .await
        .ok()?;
        results.extend(logs.into_iter().map(|l| l.try_get::<String, _>("content").unwrap_or_default()));
    }

    Some(results)
}

fn parse_indices(content: &str) -> Result<Vec<u32>, Box<dyn std::error::Error>> {
    let start = content.find('[');
    let end   = content.rfind(']');
    if let (Some(s), Some(e)) = (start, end) {
        let indices: Vec<u32> = serde_json::from_str(&content[s..=e])?;
        return Ok(indices);
    }
    if content.trim().is_empty() { return Ok(vec![]); }
    match serde_json::from_str(content) {
        Ok(indices) => Ok(indices),
        Err(_) => Err(format!("Failed to parse indices: {}", content).into()),
    }
}
