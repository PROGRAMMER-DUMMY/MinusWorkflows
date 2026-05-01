use sqlx::postgres::PgPool;
use std::env;

pub async fn init_pool() -> PgPool {
    let database_url = env::var("DATABASE_URL").expect("DATABASE_URL must be set");
    let pool = PgPool::connect(&database_url)
        .await
        .expect("Failed to connect to Postgres");

    // Simple migration logic
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS episodes (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            project_id UUID NOT NULL,
            team_id UUID NOT NULL,
            user_id UUID NOT NULL,
            name TEXT NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );"
    )
    .execute(&pool)
    .await
    .expect("Failed to create episodes table");

    sqlx::query(
        "CREATE INDEX IF NOT EXISTS idx_episodes_multi_tenant ON episodes (project_id, team_id, user_id);"
    )
    .execute(&pool)
    .await
    .expect("Failed to create episodes index");

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS text_logs (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            project_id UUID NOT NULL,
            team_id UUID NOT NULL,
            user_id UUID NOT NULL,
            episode_id UUID NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
            content TEXT NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );"
    )
    .execute(&pool)
    .await
    .expect("Failed to create text_logs table");

    sqlx::query(
        "CREATE INDEX IF NOT EXISTS idx_text_logs_multi_tenant ON text_logs (project_id, team_id, user_id);"
    )
    .execute(&pool)
    .await
    .expect("Failed to create text_logs index");

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS visual_memories (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            episode_id UUID NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
            image_path TEXT NOT NULL,
            resolution_width INTEGER NOT NULL,
            resolution_height INTEGER NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );"
    )
    .execute(&pool)
    .await
    .expect("Failed to create visual_memories table");

    pool
}
