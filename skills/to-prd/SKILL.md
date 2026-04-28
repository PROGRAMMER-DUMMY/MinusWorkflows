---
name: to-prd
description: Transforms the grilled design decisions into a formal Product Requirements Document (PRD).
---

## Phase: Spec Generation
Convert the conversation context into a structured PRD.

**Requirements**:
1. **User Stories**: Define clear "As a user, I want..." statements.
2. **Technical Constraints**: List the architectural decisions made during the Grill phase.
3. **Success Criteria**: Define exactly what must be true for this feature to be considered complete.

**Output**: Save the result to `.memory/PRD_[feature_name].md`.
