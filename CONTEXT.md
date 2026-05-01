# Project Context: Minus Workflows & OCR-Memory

## Purpose
Minus Workflows is a high-precision AI engineering skill stack for Gemini CLI. The OCR-Memory system provides a long-horizon agent memory system that stores interaction history as images, achieving 10x token compression while maintaining information fidelity.

## Tech Stack
- **Orchestration Layer**: Node.js (Existing Skills)
- **OCR Engine**: Rust (Axum, SQLx, Reqwest) - Located in `ocr_memory_rust/`
- **PII & Intelligence**: Rust-native NER (Candle + DistilBERT)
- **Image Processing**: Rust (image crate, ab_glyph)
- **Database**: PostgreSQL (SQLx)
- **State/Caching**: Redis

## Domain Language
- **Trajectory**: A sequence of agent interaction events.
- **SoM (Set-of-Mark)**: Numbered red bounding boxes for image-based indexing.
- **Optical Retrieval**: Vision API-based index selection from memory images.
- **Visual Memory Bank**: Storage for PNG memories and verbatim text logs.
- **Locate-and-Transcribe**: Deterministic text recovery from selected indices.
- **Adaptive Memory Switcher**: Logic that selects between Text-Memory (Simple) and OCR-Memory (Complex) based on configurable thresholds.
- **Multi-Tenant Namespace**: The hierarchy of memory isolation: `Global -> Project -> Team -> User`.
- **Smart Scrubber**: Rust-native PII filtering using Regex + NER (Candle).

## Configuration & Mandates
- **Upgrade Authority**: The `docs/` directory is the **Authoritative Record** for all upgrades to the MinusWorkflows project.
- **Orchestrator Proactivity**: Always initiate the `minus` pipeline immediately.
- **Stack Integrity**: Maintain a 2-engine architecture (Node.js + Rust). NO PYTHON SIDECAR.
- **Memory Mode**: Configurable via `MEMORY_MODE="adaptive" | "ocr_only" | "text_only"`.
- **Adaptive Triggers**: Default threshold `turns > 5` or `tokens > 4000`.
- **Shared Memory Policy**: Default to `Project-Level` visibility for 4-team scalability.
- **Tenant Isolation**: Ensure all DB/Redis queries include `project_id` and `team_id` filters to prevent cross-tenant data leakage.
- **ALLOW_EVOLVING_GUARDRAILS**: true
