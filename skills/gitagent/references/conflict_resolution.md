# Merge Conflict Resolution Strategies

## Trivial Conflicts
Conflicts that can be resolved without deep logic understanding.
- **Import Statements**: Combine imports from both sides.
- **Variable Definitions**: If both added a variable, keep both unless names collide.
- **Formatting**: Prefer the project's standard formatter output.

## Logic Conflicts
Conflicts that change behavior.
- **Overlapping Functions**: Analyze if both changes are needed. If one refactors and another adds a feature, merge the feature into the refactored code.
- **State Changes**: If both branches modify the same state machine, ensure the final transitions are valid.

## Step-by-Step Resolution Workflow
1. Run `git status` to find all `unmerged paths`.
2. For each file:
   - Use `grep` or a script to find all `<<<<<<<`, `=======`, `>>>>>>>` blocks.
   - Read the context before and after each block.
   - Decide on `ours`, `theirs`, or a `manual merge`.
3. Test the resolution: Run the build and relevant tests.
4. If tests pass, `git add <file>`.
5. Once all files are staged, `git commit`.
