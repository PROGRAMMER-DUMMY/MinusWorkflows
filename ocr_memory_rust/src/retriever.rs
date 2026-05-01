use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::env;
use base64::{Engine as _, engine::general_purpose};
use sqlx::PgPool;
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
        Self {
            client: Client::new(),
        }
    }

    /// Retrieves relevant indices using a vision model.
    pub async fn retrieve_indices(
        &self,
        image_bytes: &[u8],
        query: &str,
        backend: Backend,
    ) -> Result<Vec<u32>, Box<dyn std::error::Error>> {
        let base64_image = general_purpose::STANDARD.encode(image_bytes);
        let mime_type = match image::guess_format(image_bytes) {
            Ok(image::ImageFormat::Png) => "image/png",
            Ok(image::ImageFormat::Jpeg) => "image/jpeg",
            Ok(image::ImageFormat::Gif) => "image/gif",
            Ok(image::ImageFormat::WebP) => "image/webp",
            _ => "image/jpeg", // Default to jpeg
        };
        
        match backend {
            Backend::OpenAI => self.query_openai(&base64_image, query, mime_type).await,
            Backend::Anthropic => self.query_anthropic(&base64_image, query, mime_type).await,
            Backend::Google => self.query_google(&base64_image, query, mime_type).await,
        }
    }

    /// Retrieves context from the database across the entire project scope.
    pub async fn retrieve_project_context(
        &self,
        pool: &PgPool,
        project_id: Uuid,
        query: &str,
    ) -> Result<Vec<String>, Box<dyn std::error::Error>> {
        // 1. OPTICAL PASS (Handled by the caller usually, but let's assume this is the entry point)
        // ... (existing logic) ...

        // 2. SEMANTIC FALLBACK (If Optical fails or as a hybrid measure)
        // For now, we fetch the most recent trajectory segments from the project.
        // In a full implementation, we would compute embeddings for the query and use pgvector or brute-force cosine similarity.
        let logs = sqlx::query!(
            "SELECT content FROM text_logs \
             WHERE project_id = $1 \
             AND (content ILIKE $2 OR content % $3) \
             ORDER BY created_at DESC LIMIT 50",
            project_id,
            format!("%{}%", query), // Simple ILIKE fallback
            query                    // pg_trgm similarity fallback
        )
        .fetch_all(pool)
        .await?;

        Ok(logs.into_iter().map(|l| l.content).collect())
    }

    /// Explicit semantic fallback using basic keyword/trigram matching.
    pub async fn semantic_search_fallback(
        &self,
        pool: &PgPool,
        project_id: Uuid,
        query: &str,
    ) -> Result<Vec<String>, Box<dyn std::error::Error>> {
        // This is the 'Safety Net'
        let logs = sqlx::query!(
            "SELECT content FROM text_logs \
             WHERE project_id = $1 \
             AND content % $2 \
             ORDER BY similarity(content, $2) DESC \
             LIMIT 10",
            project_id,
            query
        )
        .fetch_all(pool)
        .await?;

        Ok(logs.into_iter().map(|l| l.content).collect())
    }

    async fn query_openai(&self, base64_image: &str, query: &str, mime_type: &str) -> Result<Vec<u32>, Box<dyn std::error::Error>> {
        let api_key = env::var("OPENAI_API_KEY").map_err(|_| "OPENAI_API_KEY not set")?;
        let url = "https://api.openai.com/v1/chat/completions";

        let response = self.client.post(url)
            .header("Authorization", format!("Bearer {}", api_key))
            .json(&json!({
                "model": "gpt-4o",
                "messages": [
                    {
                        "role": "user",
                        "content": [
                            {
                                "type": "text",
                                "text": format!("Identify the indices of the items in the image that match the query: {}. Return only a JSON list of indices, e.g., [1, 3, 7].", query)
                            },
                            {
                                "type": "image_url",
                                "image_url": {
                                    "url": format!("data:{};base64,{}", mime_type, base64_image)
                                }
                            }
                        ]
                    }
                ],
                "max_tokens": 300
            }))
            .send()
            .await?;

        if !response.status().is_success() {
            let err_text = response.text().await?;
            return Err(format!("OpenAI API error: {}", err_text).into());
        }

        let resp_json: serde_json::Value = response.json().await?;
        let content = resp_json["choices"][0]["message"]["content"]
            .as_str()
            .ok_or("Failed to parse OpenAI response content")?;

        parse_indices(content)
    }

    async fn query_anthropic(&self, base64_image: &str, query: &str, mime_type: &str) -> Result<Vec<u32>, Box<dyn std::error::Error>> {
        let api_key = env::var("ANTHROPIC_API_KEY").map_err(|_| "ANTHROPIC_API_KEY not set")?;
        let url = "https://api.anthropic.com/v1/messages";

        let response = self.client.post(url)
            .header("x-api-key", api_key)
            .header("anthropic-version", "2023-06-01")
            .json(&json!({
                "model": "claude-3-5-sonnet-20240620",
                "max_tokens": 1024,
                "messages": [
                    {
                        "role": "user",
                        "content": [
                            {
                                "type": "image",
                                "source": {
                                    "type": "base64",
                                    "media_type": mime_type,
                                    "data": base64_image
                                }
                            },
                            {
                                "type": "text",
                                "text": format!("Identify the indices of the items in the image that match the query: {}. Return only a JSON list of indices, e.g., [1, 3, 7].", query)
                            }
                        ]
                    }
                ]
            }))
            .send()
            .await?;

        if !response.status().is_success() {
            let err_text = response.text().await?;
            return Err(format!("Anthropic API error: {}", err_text).into());
        }

        let resp_json: serde_json::Value = response.json().await?;
        let content = resp_json["content"][0]["text"]
            .as_str()
            .ok_or("Failed to parse Anthropic response content")?;

        parse_indices(content)
    }

    async fn query_google(&self, base64_image: &str, query: &str, mime_type: &str) -> Result<Vec<u32>, Box<dyn std::error::Error>> {
        let api_key = env::var("GOOGLE_API_KEY").map_err(|_| "GOOGLE_API_KEY not set")?;
        let url = format!("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key={}", api_key);

        let response = self.client.post(url)
            .json(&json!({
                "contents": [
                    {
                        "parts": [
                            {
                                "text": format!("Identify the indices of the items in the image that match the query: {}. Return only a JSON list of indices, e.g., [1, 3, 7].", query)
                            },
                            {
                                "inline_data": {
                                    "mime_type": mime_type,
                                    "data": base64_image
                                }
                            }
                        ]
                    }
                ]
            }))
            .send()
            .await?;

        if !response.status().is_success() {
            let err_text = response.text().await?;
            return Err(format!("Google API error: {}", err_text).into());
        }

        let resp_json: serde_json::Value = response.json().await?;
        let content = resp_json["candidates"][0]["content"]["parts"][0]["text"]
            .as_str()
            .ok_or("Failed to parse Google response content")?;

        parse_indices(content)
    }
}

pub async fn retrieve_indices(
    image_bytes: &[u8],
    query: &str,
    backend: Backend,
) -> Result<Vec<u32>, Box<dyn std::error::Error>> {
    let client = VisionClient::new();
    client.retrieve_indices(image_bytes, query, backend).await
}

fn parse_indices(content: &str) -> Result<Vec<u32>, Box<dyn std::error::Error>> {
    // Attempt to find something that looks like [1, 2, 3] in the text
    let start = content.find('[');
    let end = content.rfind(']');

    if let (Some(s), Some(e)) = (start, end) {
        let json_str = &content[s..=e];
        let indices: Vec<u32> = serde_json::from_str(json_str)?;
        Ok(indices)
    } else {
        // Fallback or empty if no brackets found
        if content.trim().is_empty() {
            return Ok(vec![]);
        }
        // Try to parse the whole string as JSON just in case
        match serde_json::from_str(content) {
            Ok(indices) => Ok(indices),
            Err(_) => Err(format!("Failed to parse indices from response: {}", content).into()),
        }
    }
}
