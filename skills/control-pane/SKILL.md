---
name: control-pane
description: Dynamic model selection and escalation engine. Maps task metadata to model tiers and manages intelligence escalation.
---

## Intelligence Routing Logic
Analyze task metadata (`type`, `risk`, `complexity`) to determine the optimal model tier.

### 1. Tier Mapping
- **Ultra (Gemini 1.5 Pro / Ultra)**:
  - `type == "planning"`
  - `type == "architecture"`
  - `type == "diagnosis"`
  - `risk == "high"`
  - `complexity == "high"`
- **Pro (Gemini 1.5 Pro)**:
  - `type == "implementation"`
  - `type == "maintenance"`
  - `risk == "medium"`
  - `complexity == "medium"`
- **Flash (Gemini 1.5 Flash)**:
  - `type == "research"`
  - `type == "discovery"`
  - `risk == "low"`
  - `complexity == "low"`

### 2. Escalation Protocol
If a task fails its quality checks or exceeds the failure threshold:
- **Threshold**: 2 consecutive failures.
- **Path**: `Flash` -> `Pro` -> `Ultra`.
- **Action**: Increment `failure_count` in `TASKS.json` and escalate `model_tier`.

### 3. Metadata Defaults
If metadata is missing:
- Default `risk` to `medium`.
- Default `complexity` to `medium`.
- Default `model_tier` to `Pro`.
