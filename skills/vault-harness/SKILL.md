---
name: vault-harness
description: Bridges the current session to a long-term Memory Vault (Obsidian or Local). Use to retrieve past decisions, architectural patterns, and "lessons learned."
version: 1.0.0
---

## Phase: Harnessing (Isolation)
Scaffold a secure environment for high-risk development.

1.  **Sandbox Initialization**: Create a `.vault/sandbox/[task_id]` directory.
2.  **Mocking & Stubbing**: Generate isolated mocks for project dependencies (DBs, APIs).
3.  **Safety Gate**: Execute all experimental code within the sandbox first.

## Phase: Vaulting (Backup & Retrieval)
Bridge the current session to long-term memory and local backups.

1.  **Golden State Archive**: After a successful `Builder` phase, copy the verified code and its "Verification Harness" to `.vault/backups/`.
2. **Context Retrieval**: Search the vault for past decisions or architectural patterns.
3. **Indexing**: Automatically maintain a `.vault/INDEX.md` that maps `[[wikilinks]]` to specific snapshots and ADRs.
4. **Cross-Project Wisdom**: Query Global Vaults for high-level engineering patterns.


Format memory nodes with `[[wikilinks]]`. Ensure everything is stored locally for future-proofing and recovery.
