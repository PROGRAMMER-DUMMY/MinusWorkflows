---
name: to-issues
description: Breaks a PRD or Roadmap into independently-grabbable implementation tasks.
version: 1.0.0
---

## Phase: Task Breakdown
Slice the work into vertical "Tracer Bullets."

1. **Atomic Tasks**: Each issue must be a single, testable change.
2. **Dependency Mapping**: Clearly state which issues must be finished before others can start.
3. **Verification Steps**: Every task must include a "How to Test" section.

**Output**: Save the task list to `.memory/sessions/[session_id]/[query_id]/TASKS.md` or create GitHub issues if requested.
