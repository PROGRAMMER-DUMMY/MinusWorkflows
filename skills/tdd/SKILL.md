---
name: tdd
description: Test-Driven Development loop. PRD to code via Red-Green-Refactor.
---

## Phase: Implementation (TDD)
Execute the implementation using strict test-driven discipline.

1. **Step 1: Red (Test First)**: Create a reproduction script or unit test that fails.
2. **Step 1.5: Test Audit (Anti-Loop Check)**: Activate `auditor`. The auditor MUST verify that the failing test is logically sound, directly maps to the PRD, and is not physically impossible to pass. Do NOT proceed to Step 2 until the test logic is verified.
3. **Step 2: Green (Implementation)**: Write the minimal code needed to make the test pass.
4. **Step 3: Refactor**: Clean up the code while ensuring the test remains green.
5. **Step 4: Regression**: Run all related project tests to ensure no breakages.

**Rules**:
- Never add "just-in-case" logic. Only write code that satisfies the test.
- Every turn must include a validation step (running the test).

**Goal**: Delivery of verified, high-integrity code.
