---
name: gitagent
description: Expert Git workflow automation and conflict resolution. Use when the user wants to create new features on branches, manage pull requests, resolve merge conflicts, or perform complex git operations according to industry standards.
version: 1.0.0
---

# GitAgent

## Workflows

### 1. Feature Branching (Industry Standard)
Always isolate new work.
1. Sync with source: `git checkout main && git pull origin main`
2. Create feature branch: `git checkout -b <type>/<description>`
   - `type`: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`
   - `description`: kebab-case summary (e.g., `auth-fix`)

### 2. Expert Committing
Use **Conventional Commits** for clear history.
- Format: `<type>: <description>`
- Include a body for complex changes to explain *why*, not *what*.
- Stage only relevant changes: `git add -p` for surgical commits.

### 3. Conflict Resolution
Handle merges and rebases with precision.
1. Identify conflicts: `git status`
2. Analyze context: Read the code surrounding conflict markers.
3. Apply resolution: See [conflict_resolution.md](references/conflict_resolution.md) for specific strategies.
4. Verify: Run tests before staging.
5. Finalize: `git add <file>` then `git commit`.

### 4. Collaboration & Pull Requests
Industry standard requires human review. **Never merge directly into main.**
1. **Sync**: `git pull --rebase origin main`
2. **Push**: `git push origin <branch-name>`
3. **Create PR**: 
   - If `gh` CLI is available: `gh pr create --title "<type>: <summary>" --body "<details>"`
   - Otherwise: Provide the user with the GitHub/GitLab URL to create the PR manually.
4. **Human Review**: Wait for human approval/comments. Do not proceed with merge until approved.

### 5. Advanced Maintenance
- **Surgical Undo**: Use `git restore --source=HEAD~1 <file>` to revert specific files.
- **History Rewriting**: Use `git rebase -i` to clean up local commit history before pushing.
- **State Recovery**: Use `git reflog` if a branch is accidentally deleted or a rebase goes wrong.
