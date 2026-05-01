---
name: architect
description: Ideation to PRD. Combines grill-me, domain-model, to-prd, and auditor.
---

0. **Step 0: Context Mapping**: Activate `minustoken L1`. Run `uvx code-review-graph update`.
0.5 **Step 0.5: Discovery**: Activate `discovery`. Scan for tech debt and patterns to inform recommendations.
1. **Phase 1: Grilling**: Activate `grill-me`. Resolve design ambiguities using the Discovery Report. Ensure you provide explicit recommendations.
2. **Phase 2: Alignment**: Activate `domain-model`. Sync with `CONTEXT.md`.
2.5 **Phase 2.5: Security & Testing (Safe-Zoning)**: Explicitly ask the user to refine the plan concerning security vulnerabilities, test strategies, and edge cases. Ask: "Does this need more refinement for security or testing before we generate the PRD?"
3. **Phase 3: Generation**: Activate `to-prd`. Create the formal spec.
4. **Phase 4: Audit**: Activate `auditor`. Ensure the PRD matches the user's intent perfectly.
5. **Phase 5: Cleanup**: Activate `evolve`. Activate `enforcer`. Unload Architect skills to prep for Planning.
