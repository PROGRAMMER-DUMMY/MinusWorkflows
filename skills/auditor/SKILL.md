---
name: auditor
description: Automated quality gate that validates the current state against the original requirements. Use at every phase transition.
version: 1.0.0
---

## Phase: Audit
**CRITICAL**: Drop all Minustoken compression. Force **Tier L1 (Full Fidelity)**.

1. **Requirement Sync**: Compare the current code/design against the PRD.
2. **Drift Detection**: Identify any "feature creep" or missing logic.
3. **Safety Check**: Ensure no security vulnerabilities or destructive patterns were introduced.

**Rules**:
- If drift is detected, block transition to the next phase.
- Require explicit user confirmation to proceed if "Quality Debt" is identified.
