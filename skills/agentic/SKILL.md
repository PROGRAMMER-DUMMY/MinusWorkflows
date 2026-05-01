---
name: agentic
description: Orchestrates the creation of new Gemini CLI capabilities by combining write-a-skill and skill-creator. Use when you want to extend the agent's power.
---

You are now in the "Agentic" workflow. Your goal is to teach Gemini a new specialized skill:

1.  **Phase 1: Scaffolding**: Activate `write-a-skill`. Define the core structure, instructions, and resources for the new capability.
2.  **Phase 2: Prompt Engineering**: Activate `skill-creator`. Refine the skill's instructions using advanced prompt engineering techniques to ensure high reliability and expert-level performance.
3.  **Phase 3: Synchronization**: Execute `node utils/skill_sync.js` to link the new skill to the Gemini CLI. Notify the user to run `/skills reload`.
