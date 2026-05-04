use sqlx::PgPool;
use std::collections::HashMap;
use std::env;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::Mutex;
use metrics_exporter_prometheus::PrometheusHandle;
use crate::db;
use crate::scrubber::{self, SmartScrubber};
use crate::retriever::Backend;

// Per-key rate limit bucket: (request_count, window_start_secs_since_epoch)
pub type RateLimiter = Arc<Mutex<HashMap<String, (u32, u64)>>>;

// ── Cache backend ─────────────────────────────────────────────────────────────
// Lite mode  → Disk: JSON files in ./cache/, TTL enforced at read time.
// Standard/Full → Redis: ConnectionManager with SETEX.

#[derive(Clone)]
pub enum CacheBackend {
    Disk(PathBuf),
    Redis(redis::aio::ConnectionManager),
}

// ── App state ─────────────────────────────────────────────────────────────────

#[derive(Clone)]
pub struct AppState {
    pub db: PgPool,
    pub cache: CacheBackend,
    pub scrubber: Arc<SmartScrubber>,
    pub prometheus: PrometheusHandle,
    pub vision_backend: Option<Backend>,
    pub mode: Mode,
    /// Bearer token required on /memory/* routes. None = unauthenticated (dev only).
    pub api_key: Option<String>,
    /// Root directory for rendered PNG files — resolved from MEMORY_BASE_DIR env.
    pub memory_base: PathBuf,
    /// Per-API-key request count within rolling 60s window. Keyed by raw key value.
    pub rate_limiter: RateLimiter,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Mode { Lite, Standard, Full }

impl Mode {
    pub fn from_env() -> Self {
        match env::var("MODE").unwrap_or_default().to_lowercase().as_str() {
            "lite"     => Mode::Lite,
            "standard" => Mode::Standard,
            _          => Mode::Full,
        }
    }
}

// ── Init ──────────────────────────────────────────────────────────────────────

pub async fn init_state(prometheus: PrometheusHandle) -> AppState {
    let mode = Mode::from_env();
    tracing::info!(?mode, "starting OCR-Memory service");

    let pool = db::init_pool().await;

    let cache = match mode {
        Mode::Lite => {
            let dir = PathBuf::from("./cache");
            std::fs::create_dir_all(&dir).ok();
            CacheBackend::Disk(dir)
        }
        Mode::Standard | Mode::Full => {
            let url = env::var("REDIS_URL").unwrap_or_else(|_| "redis://127.0.0.1/".to_string());
            let client = redis::Client::open(url).expect("Invalid REDIS_URL");
            let mgr = redis::aio::ConnectionManager::new(client)
                .await
                .expect("Failed to connect to Redis");
            CacheBackend::Redis(mgr)
        }
    };

    // NER model download is blocking — run off the async executor regardless of mode.
    // Without `--features ner` this is instant (empty struct).
    let scrubber = tokio::task::spawn_blocking(|| scrubber::init_scrubber())
        .await
        .expect("scrubber thread panicked")
        .expect("Failed to initialize scrubber");

    let vision_backend = detect_vision_backend();

    let api_key = env::var("API_KEY").ok().filter(|k| !k.is_empty());
    if api_key.is_none() {
        tracing::warn!("API_KEY not set — /memory/* endpoints are unauthenticated");
    }

    let memory_base = PathBuf::from(
        env::var("MEMORY_BASE_DIR").unwrap_or_else(|_| "./memory_bank".to_string()),
    );
    std::fs::create_dir_all(&memory_base).ok();

    AppState {
        db: pool,
        cache,
        scrubber: Arc::new(scrubber),
        prometheus,
        vision_backend,
        mode,
        api_key,
        memory_base,
        rate_limiter: Arc::new(Mutex::new(HashMap::new())),
    }
}

fn detect_vision_backend() -> Option<Backend> {
    let explicit = env::var("VISION_BACKEND").unwrap_or_default().to_lowercase();
    match explicit.as_str() {
        "openai"    if env::var("OPENAI_API_KEY").is_ok()    => return Some(Backend::OpenAI),
        "anthropic" if env::var("ANTHROPIC_API_KEY").is_ok() => return Some(Backend::Anthropic),
        "google"    if env::var("GOOGLE_API_KEY").is_ok()    => return Some(Backend::Google),
        _ => {}
    }
    // Auto-infer from AGENT_PROVIDER=http + AGENT_API_FORMAT + AGENT_API_KEY so users only
    // need to configure the agent provider once rather than setting VISION_BACKEND separately.
    if env::var("AGENT_PROVIDER").as_deref() == Ok("http") {
        let api_key = env::var("AGENT_API_KEY").unwrap_or_default();
        if !api_key.is_empty() {
            let format = env::var("AGENT_API_FORMAT").unwrap_or_default().to_lowercase();
            match format.as_str() {
                "anthropic" => return Some(Backend::Anthropic),
                "openai"    => return Some(Backend::OpenAI),
                "google"    => return Some(Backend::Google),
                _ => {}
            }
        }
    }
    if env::var("ANTHROPIC_API_KEY").is_ok() { return Some(Backend::Anthropic); }
    if env::var("OPENAI_API_KEY").is_ok()    { return Some(Backend::OpenAI); }
    if env::var("GOOGLE_API_KEY").is_ok()    { return Some(Backend::Google); }
    None
}
