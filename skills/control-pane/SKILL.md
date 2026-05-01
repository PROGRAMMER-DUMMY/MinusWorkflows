---
name: control-pane
description: Dynamic model selection and escalation engine. Maps task metadata to model tiers and manages intelligence escalation.
---

## Intelligence Routing Logic
Analyze task metadata (`type`, `risk`, `complexity`) to determine the optimal model tier, respecting user budget and available models.

### 1. Model Discovery
Before routing, determine available models using the scanner utility:
- Execute `utils/scanner.js` to detect available APIs (`gemini`, `claude`, `openai`) via environment variables or `.memory/models.json`.
- If none are found, the scanner will prompt the user to manually select a fallback model.

### 2. Tier Mapping
Determine the baseline tier based on metadata:
- **Ultra**:
  - `type == "planning"`, `"architecture"`, or `"diagnosis"`
  - `risk == "high"` OR `complexity == "high"`
- **Pro**:
  - `type == "implementation"` or `"maintenance"`
  - `risk == "medium"` AND `complexity == "medium"`
- **Flash**:
  - `type == "research"` or `"discovery"`
  - `risk == "low"` AND `complexity == "low"`

### 3. Budget Authorization
Once a baseline tier is selected, enforce cost-awareness:
- Execute `utils/budget_tracker.js` via `authorizeModelTier(tier, estimatedCost)`.
- If the session strategy is "low", requests for "Ultra" are automatically downgraded to "Pro".
- If the hard limit is reached, execution is halted.
- If "Ultra" is approved by strategy but no explicit override exists, prompt the user for confirmation to prevent accidental burn.

### 4. Escalation Protocol
If a task fails its quality checks or exceeds the failure threshold:
- **Threshold**: 2 consecutive failures.
- **Path**: `Flash` -> `Pro` -> `Ultra`.
- **Action**: Increment `failure_count` in `TASKS.json` and escalate `model_tier`. (Must re-run Budget Authorization).

### 5. Metadata Defaults
If metadata is missing:
- Default `risk` to `medium`.
- Default `complexity` to `medium`.
- Default `model_tier` to `Pro`.
