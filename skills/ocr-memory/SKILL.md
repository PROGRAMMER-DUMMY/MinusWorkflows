---
name: ocr-memory
description: Instructions for using the OCR-Memory service to store trajectories and retrieve context from the memory bank.
---

## Phase: Memory Management
Utilize the OCR-Memory service to maintain long-term context and learn from previous trajectories.

### Adaptive Switcher (Gatekeeper Logic)
Before every memory operation, evaluate the current session state to decide the storage strategy:
- **Condition 1 (Local Memory)**: If `turn_count < 5` AND `total_tokens < 4000`.
  - **Action**: Use standard local session text memory (no OCR-Memory API call).
- **Condition 2 (OCR-Memory)**: If `turn_count >= 5` OR `total_tokens >= 4000`.
  - **Action**: Activate OCR-Memory by sending a POST request to `/memory/store`.

1.  **Store Trajectory**:
    - **Trigger**: Upon meeting Condition 2, or after significant milestones.
    - **Action**: Send a POST request to `/memory/store`.
    - **Payload**:
      ```json
      {
        "episode_id": "unique-session-id",
        "events": [
          { "type": "action", "description": "...", "timestamp": "..." },
          { "type": "observation", "description": "...", "timestamp": "..." }
        ]
      }
      ```
    - **Goal**: Persist the current sequence of events for future retrieval and analysis.

2.  **Retrieve Context**:
    - **Trigger**: When starting a new task, encountering a familiar problem, or needing historical data.
    - **Action**: Send a POST request to `/memory/retrieve`.
    - **Payload**:
      ```json
      {
        "query": "search term or description",
        "episode_id": "unique-session-id"
      }
      ```
    - **Goal**: Fetch relevant past events to inform current decision-making.

## API Endpoints (Local)
The OCR-Memory service is assumed to be running on `http://localhost:3000`.

- `POST /memory/store`: Store events for a specific episode.
- `POST /memory/retrieve`: Retrieve events based on a query and episode ID.

## Interaction Patterns
- **Serializing State**: Before storing, consolidate findings into a list of discrete events.
- **Contextual Awareness**: Use retrieved context to avoid redundant research or repeated failures.
- **Episode Tracking**: Ensure the `episode_id` remains consistent across a single logical workflow or project session.

**Usage**: `Gemini, activate_skill: ocr-memory`
