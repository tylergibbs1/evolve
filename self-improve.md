# Evolve Self-Improvement Protocol

You are an autonomous research agent improving the Evolve codebase.

## Setup

1. Create branch `self-improve/<tag>` from current main
2. Read the codebase for full context:
   - `packages/core/src/*.ts` — core framework (archive, selection, evaluation, loop, tools, LLM)
   - `packages/core/src/**/*.test.ts` — test suite (your ground truth)
   - `packages/cli/src/*.ts` — CLI
   - `packages/initial-agent/*.ts` — initial agent template
3. Run baseline: `bun test --exclude='**/integration*' --exclude='**/smoke*' && bunx tsc --noEmit`
4. Record baseline in results.tsv

## The Loop

NEVER STOP. Do NOT pause to ask the human for permission or confirmation.

```
LOOP FOREVER:
1. Read results.tsv to see what's been tried
2. Propose ONE concrete optimization — pick from the categories below
3. Edit the relevant source files
4. git commit with a short description
5. Run: bun test --exclude='**/integration*' --exclude='**/smoke*' 2>&1 | tee run.log
6. Run: bunx tsc --noEmit >> run.log 2>&1
7. Parse results:
   - tests_passed: count of passing tests
   - tests_failed: count of failing tests
   - typecheck: pass or fail
8. Record in results.tsv
9. If ALL tests pass AND typecheck passes → KEEP (advance branch)
10. If ANY test fails OR typecheck fails → git reset --hard HEAD~1 (revert)
11. Go to 1
```

## What to Optimize

Pick ONE thing per iteration. Small, focused changes only.

### Performance
- Reduce allocations in hot paths (selection, evaluation, archive queries)
- Use prepared statements more effectively in archive
- Batch database operations where possible
- Reduce unnecessary copies in the evolution loop

### Correctness
- Add missing edge case handling found by reading code
- Fix potential race conditions in parallel parent processing
- Improve error messages and error propagation
- Strengthen type safety (narrower types, better branded ID usage)

### Architecture
- Extract duplicated tool execution logic into shared helpers
- Simplify the runToolLoop message construction
- Reduce coupling between modules
- Make interfaces more composable

### Test Coverage
- Add tests for uncovered edge cases
- Add tests for error paths
- Add regression tests for bugs you fix
- Improve test isolation

### Features (small, self-contained)
- Add plateau detection (stop if no improvement in N iterations)
- Add cost-per-agent tracking in the archive
- Add archive export/import as JSON
- Add score history per agent

## Rules

1. **One change per commit.** Never bundle unrelated changes.
2. **Tests are ground truth.** If a test fails, your change is wrong, not the test. (Unless the test itself has a bug — fix the test in a SEPARATE commit first.)
3. **Do not modify test files and source files in the same commit.** If you need to update tests for a new feature, commit the test first, then the feature.
4. **Typecheck must pass.** `bunx tsc --noEmit` is non-negotiable.
5. **Do not add dependencies.** Work with what's in the repo.
6. **Do not modify integration tests or smoke tests.** Those require real API keys.
7. **Simpler is better.** A small improvement that adds ugly complexity is not worth it.
8. **Read before writing.** Always read a file before editing it.
9. **Never break the public API.** Exported types and function signatures are stable.

## results.tsv Format

Tab-separated. Do NOT use commas. Columns:

```
commit	tests_passed	tests_failed	typecheck	status	description
```

- **commit**: 7-char git hash
- **tests_passed**: number of passing tests
- **tests_failed**: number of failing tests
- **typecheck**: `pass` or `fail`
- **status**: `keep`, `discard`, or `crash`
- **description**: short description of what you changed

## Metrics

The primary metric is: **all tests pass + typecheck clean + code is simpler/faster/more correct.**

There is no single numeric score. Instead:
- tests_passed should monotonically increase (as you add tests)
- tests_failed should always be 0 for kept commits
- typecheck should always be `pass` for kept commits

## Getting Started

```bash
git checkout -b self-improve/<tag>
bun test --exclude='**/integration*' --exclude='**/smoke*' 2>&1 | tee run.log
bunx tsc --noEmit >> run.log 2>&1
# Record baseline in results.tsv
# Start the loop
```
