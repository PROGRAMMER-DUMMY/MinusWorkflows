# Evolution Log

## Feature: Dynamic Model Routing & Budgeting
- **Scenario**: Orchestrator needed dynamic cost-aware model assignment and scoped personal context for parallel sub-agents.
- **Action Taken**: Implemented `utils/scanner.js` and `utils/budget_tracker.js`. Updated `control-pane` to inject these steps before tier selection. Updated `orchestrator` to inject personal context (role + scoped CONTEXT.md) into sub-agent prompts.
- **Result**: Success. The system can now degrade gracefully or prompt the user if an expensive model is requested unexpectedly.

## Feature: GitAgent Capability
- **Scenario**: User requires specialized Git workflow management and conflict resolution according to industry standards.
- **Action Taken**: Designed, packaged, and installed a dedicated `gitagent` skill. It enforces feature branching, conventional commits, and semi-automated conflict resolution.
- **Result**: Success. The agent can now handle complex Git tasks with professional guardrails.

## Feature: Integrated Git/GitHub Skills
- **Scenario**: User wanted to integrate existing high-quality Git/GitHub skills into the MinusWorkflows stack.
- **Action Taken**: Integrated `github-triage`, `setup-pre-commit`, and `git-guardrails` skills into the `skills/` directory and updated documentation.
- **Result**: Success. The stack now includes robust repo maintenance, safety hooks, and quality-gate automation.

## Feature: Benchmarking & Evidence Suite
- **Scenario**: User requires undeniable proof and industry-standard benchmarks (SWE-bench) to convince leadership and tech companies.
- **Action Taken**: Designed a PRD and Roadmap for a Comparative Benchmark Suite. It includes side-by-side runners (Baseline vs. Minus), a Comparative Report Generator, and a Pitch Deck asset.
- **Result**: Ready for implementation. The plan focuses on Accuracy, Economics, and Search Precision.
