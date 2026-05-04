use axum::http::HeaderMap;
use metrics_exporter_prometheus::{PrometheusBuilder, PrometheusHandle};

pub fn init_tracing() {
    tracing_subscriber::fmt()
        .json()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| {
                tracing_subscriber::EnvFilter::new("info,ocr_memory_rust=debug,tower_http=info")
            }),
        )
        .with_current_span(true)
        .init();
}

pub fn init_metrics() -> PrometheusHandle {
    PrometheusBuilder::new()
        .install_recorder()
        .expect("Failed to install Prometheus metrics recorder")
}

pub fn request_id(headers: &HeaderMap) -> String {
    headers
        .get("x-request-id")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("no-req-id")
        .to_string()
}
