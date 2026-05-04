---
name: diagnose
description: Disciplined debugging loop for hard bugs and performance regressions. Reproduce -> Hypothesise -> Fix.
version: 1.0.0
---

## Phase: Diagnosis
Follow a scientific method to isolate and fix the root cause.

0. **Step 0: Triage Sync**: Activate `minustoken L2`.
1. **Step 1: Reproduction**: Create a minimal script or test that proves the failure.
2. **Step 2: Trace**: Use the `Mapper` skill to identify all functions in the call chain of the failing component.
3. **Step 3: Hypothesis**: State the suspected root cause based on the trace and logs.
4. **Step 4: Instrumentation**: Add surgical logging or print statements to verify the hypothesis.
5. **Step 5: Fix & Verify**: Apply the fix and run the reproduction script to ensure it passes.

**Rules**:
- Never attempt a fix until the bug is reproduced.
- If a fix fails, revert the changes immediately and revisit the Hypothesis phase.

**Goal**: Professional-grade triage and repair without side effects.
