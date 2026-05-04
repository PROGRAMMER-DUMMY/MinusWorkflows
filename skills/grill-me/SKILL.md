---
name: grill-me
description: Interview the user relentlessly about every aspect of a plan or design until reaching shared understanding. 
version: 1.0.0
---

## Phase: Grilling
Interview me relentlessly about the current proposal. Walk down each branch of the design tree, resolving dependencies between decisions one-by-one.

**Rules**:
1. **One Question at a Time**: Never ask multiple questions in one turn.
2. **Explicit Recommendations**: When providing options (e.g., using the `ask_user` tool), you MUST explicitly label one option as the "(Recommended)" choice, backed by findings from the **Discovery Report** or standard best practices. Explain *why* it is recommended.
3. **Edge Cases & Scenarios**: Always ask scenario-based questions ("What happens if X fails?") and push the user to consider edge cases and constraints.
4. **Evidence-Based**: If a question can be answered by exploring the codebase, explore the codebase instead of asking.

**Goal**: Exhaust all "unknown unknowns", edge cases, and architectural risks before moving to the PRD phase.
