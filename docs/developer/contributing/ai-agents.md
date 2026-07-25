# AI Agent Rules

Rules governing AI agent contributions to this repository.

## Git Rules

### Prohibited Operations

- **No** `git commit --amend`
- **No** `git rebase`
- **No** `git push --force`
- **No** any command that rewrites git history

These operations destroy code review context and can corrupt CI/build pipelines.

### Branch Management

- **Must NOT** create branches (`git checkout -b`) unless explicitly instructed by the user
- **Must NOT** infer the current branch state via `git branch` or `git status` to decide actions
- **Must** ask for confirmation if the user invokes `/review` or similar without stating their branch
- **The user is responsible for branch management**

### Commits

- **Must** create a new conventional commit for each set of changes
- **Must NOT** amend or squash commits on behalf of the user
- **Must** run `npm run preflight` before committing

## Code Rules

### Before Making Changes

1. Read the relevant source files
2. Understand existing code patterns
3. Check for similar implementations
4. Follow existing conventions

### While Making Changes

1. Write code that matches existing style
2. Add tests for new logic
3. Update documentation if needed
4. Never introduce secrets or keys

### After Making Changes

1. Run `npm run preflight`
2. Fix any lint errors
3. Fix any test failures
4. Fix any build errors

## Documentation Rules

- Update docs when changing user-facing features
- Follow existing documentation structure
- Use English for all new documentation
- Include code examples where helpful

## PR Rules

- Use the PR template
- Fill in all checklist items
- Wait for CI to pass
- Address review feedback promptly
