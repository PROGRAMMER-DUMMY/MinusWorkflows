use sqlx::postgres::PgPool;
use std::env;

pub async fn init_pool() -> PgPool {
    let database_url = env::var("DATABASE_URL").expect("DATABASE_URL must be set");
    let pool = PgPool::connect(&database_url)
        .await
        .expect("Failed to connect to Postgres");

    run_migrations(&pool).await;
    pool
}

async fn run_migrations(pool: &PgPool) {
    // pgvector for semantic/embedding search
    sqlx::query("CREATE EXTENSION IF NOT EXISTS vector")
        .execute(pool)
        .await
        .expect("Failed to create pgvector extension");

    // pg_trgm required for similarity search in text_logs
    sqlx::query("CREATE EXTENSION IF NOT EXISTS pg_trgm")
        .execute(pool)
        .await
        .expect("Failed to create pg_trgm extension");

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS episodes (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            project_id UUID NOT NULL,
            team_id UUID NOT NULL,
            user_id UUID NOT NULL,
            name TEXT NOT NULL,
            embedding vector(1536),
            created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );",
    )
    .execute(pool)
    .await
    .expect("Failed to create episodes table");

    // Idempotent: adds embedding column to any existing deployment
    let _ = sqlx::query(
        "ALTER TABLE episodes ADD COLUMN IF NOT EXISTS embedding vector(1536)",
    )
    .execute(pool)
    .await;

    sqlx::query(
        "CREATE INDEX IF NOT EXISTS idx_episodes_multi_tenant \
         ON episodes (project_id, team_id, user_id);",
    )
    .execute(pool)
    .await
    .expect("Failed to create episodes index");

    // HNSW index for cosine similarity search on embeddings (pgvector >= 0.5)
    sqlx::query(
        "CREATE INDEX IF NOT EXISTS idx_episodes_embedding \
         ON episodes USING hnsw (embedding vector_cosine_ops);",
    )
    .execute(pool)
    .await
    .expect("Failed to create embedding index");

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS text_logs (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            project_id UUID NOT NULL,
            team_id UUID NOT NULL,
            user_id UUID NOT NULL,
            episode_id UUID NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
            content TEXT NOT NULL,
            seq_index INTEGER NOT NULL DEFAULT 0,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );",
    )
    .execute(pool)
    .await
    .expect("Failed to create text_logs table");

    // Idempotent: adds seq_index to any existing deployment that predates this migration
    let _ = sqlx::query(
        "ALTER TABLE text_logs ADD COLUMN IF NOT EXISTS seq_index INTEGER NOT NULL DEFAULT 0",
    )
    .execute(pool)
    .await;

    sqlx::query(
        "CREATE INDEX IF NOT EXISTS idx_text_logs_multi_tenant \
         ON text_logs (project_id, team_id, user_id);",
    )
    .execute(pool)
    .await
    .expect("Failed to create text_logs tenant index");

    // seq_index lookup used by optical retrieve path
    sqlx::query(
        "CREATE INDEX IF NOT EXISTS idx_text_logs_episode_seq \
         ON text_logs (episode_id, seq_index);",
    )
    .execute(pool)
    .await
    .expect("Failed to create episode seq index");

    // GIN trigram index used by text similarity search
    sqlx::query(
        "CREATE INDEX IF NOT EXISTS idx_text_logs_trgm \
         ON text_logs USING GIN (content gin_trgm_ops);",
    )
    .execute(pool)
    .await
    .expect("Failed to create trigram index");

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS visual_memories (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            episode_id UUID NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
            image_path TEXT NOT NULL,
            resolution_width INTEGER NOT NULL,
            resolution_height INTEGER NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );",
    )
    .execute(pool)
    .await
    .expect("Failed to create visual_memories table");

    // Soft-delete support for retention policy
    let _ = sqlx::query(
        "ALTER TABLE episodes ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ",
    )
    .execute(pool)
    .await;

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS api_keys (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            key_hash TEXT NOT NULL UNIQUE,
            project_id UUID,
            label TEXT NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            expires_at TIMESTAMPTZ,
            last_used_at TIMESTAMPTZ
        );",
    )
    .execute(pool)
    .await
    .expect("Failed to create api_keys table");

    sqlx::query(
        "CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys (key_hash);",
    )
    .execute(pool)
    .await
    .expect("Failed to create api_keys index");

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS audit_log (
            id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            key_id     UUID,
            action     TEXT NOT NULL,
            project_id UUID,
            req_id     TEXT,
            status     TEXT NOT NULL,
            meta       JSONB,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );",
    )
    .execute(pool)
    .await
    .expect("Failed to create audit_log table");

    sqlx::query(
        "CREATE INDEX IF NOT EXISTS idx_audit_log_key_id ON audit_log (key_id);",
    )
    .execute(pool)
    .await
    .expect("Failed to create audit_log key_id index");

    sqlx::query(
        "CREATE INDEX IF NOT EXISTS idx_audit_log_created_at ON audit_log (created_at DESC);",
    )
    .execute(pool)
    .await
    .expect("Failed to create audit_log time index");
}
