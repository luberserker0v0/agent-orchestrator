# Contribution Workflow

## Branch Strategy

1. **Never commit directly to `main`**
2. Create a feature branch from `main`

```bash
git checkout main
git pull origin main
git checkout -b feat/<descriptive-name>
```

## Making Changes

1. Make your changes
2. Follow [coding standards](../coding-standards.md)
3. Add tests for new logic
4. Update documentation if needed

## Before Committing

Run the full verification pipeline:

```bash
npm run preflight
```

This runs:
- `npm run lint` — Must pass with 0 errors
- `npm run test` — Must pass with 100% success
- `npm run build` — TypeScript must compile cleanly

**Shortcut:** `npm run preflight` runs all three.

## Commit Messages

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <description>

<body>
```

### Types

| Type | Description |
|------|-------------|
| `feat` | New feature |
| `fix` | Bug fix |
| `docs` | Documentation |
| `style` | Formatting (no code change) |
| `refactor` | Code restructuring |
| `test` | Adding/updating tests |
| `chore` | Build, CI, dependencies |

### Examples

```
feat(orchestrator): add LRU eviction for max instances
test(port-pool): add unit tests for allocation edge cases
fix(websocket): resolve heartbeat timeout handling
docs: restructure documentation
```

## Pull Request Process

### 1. Push Your Branch

```bash
git push -u origin feat/<name>
```

### 2. Create a Pull Request

Use the PR template in `.github/pull_request_template.md`:

```markdown
## Summary
Brief description of what changed and why.

## Changes
- List each significant change
- Include file names if helpful

## Testing
- How was this tested?
- Any manual verification steps?

## Checklist
- [ ] `npm run lint` passes
- [ ] `npm run test` passes
- [ ] `npm run build` compiles
- [ ] Tests added for new logic
- [ ] Documentation updated if needed
- [ ] Follows Conventional Commits
```

### 3. Wait for CI

GitHub Actions runs:
- `npm ci`
- `npm run preflight` (lint + test + build)
- `npm run test:coverage`

All checks must pass before merging.

### 4. Review

- Review all commits in the PR
- Address review feedback
- Update PR description if needed

### 5. Merge

Use "Squash and merge" for clean history.

### 6. Clean Up

Delete the feature branch after merge.

## Commit Completeness Check

After your final commit, verify no changes are left behind:

```bash
git status
```

If the working tree is not clean, either:
- Stage and commit the remaining changes
- Add them to `.gitignore` if they should not be tracked

**Never push while there are uncommitted modifications.**

## Bypassing Hooks

In emergencies only:

```bash
git commit --no-verify   # Skip pre-commit hook
git push --no-verify     # Skip pre-push hook
```

Use sparingly. Hooks exist for quality assurance.
