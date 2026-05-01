use sqlx::PgPool;
use redis::Client;
use std::env;
use std::sync::Arc;
use crate::db;
use crate::scrubber::{self, SmartScrubber};

#[derive(Clone)]
pub struct AppState {
    pub db: PgPool,
    pub redis: Client,
    pub scrubber: Arc<SmartScrubber>,
}

pub async fn init_state() -> AppState {
    let pool = db::init_pool().await;
    
    let redis_url = env::var("REDIS_URL").unwrap_or_else(|_| "redis://127.0.0.1/".to_string());
    let redis_client = Client::open(redis_url).expect("Invalid Redis URL");
    
    let scrubber = scrubber::init_scrubber().expect("Failed to initialize SmartScrubber");
    
    AppState {
        db: pool,
        redis: redis_client,
        scrubber: Arc::new(scrubber),
    }
}
