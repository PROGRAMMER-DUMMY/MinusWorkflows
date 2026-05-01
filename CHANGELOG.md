# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Added
- **Dynamic Model Routing:** Orchestrator now uses a scanner (`utils/scanner.js`) to detect available AI models via environment variables, CLI configurations, and explicit configs (`.memory/models.json`).
- **Cost Awareness & Budgeting:** Introduced `utils/budget_tracker.js` to handle tiered budgeting (low, medium, unlimited), hard limits, and confirmation prompts for expensive Ultra-tier models.
- **Scoped Personal Context:** Sub-agents now receive a strictly scoped subset of `CONTEXT.md` based on their assigned role and dependencies to prevent context bloat.
- **Security & Testing Phase:** Added "Phase 2.5: Security & Testing (Safe-Zoning)" to the `architect` skill to ensure vulnerability and edge-case checks before PRD generation.

### Changed
- `grill-me` skill now explicitly requires the agent to recommend an option when asking questions and must include scenario-based edge-case questions.
- `orchestrator` tool scoping updated to pass explicit model tiers to sub-agents.
- `control-pane` logic updated to integrate with the new budget and scanner utilities before authorizing model tiers.
