
Default to using Bun instead of Node.js.

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun install` instead of `npm install`
- Use `bun run <script>` instead of `npm run <script>`
- Bun automatically loads .env, so don't use dotenv.

## APIs

- `Bun.serve()` for HTTP servers. Don't use `express`.
- `bun:sqlite` for SQLite. Don't use `better-sqlite3`.
- `Bun.file` over `node:fs`'s readFile/writeFile.
- `Bun.spawn()` for subprocesses.

## Project Structure

Bun workspace monorepo:
- `packages/core/` — Core library (@evolve/core): types, archive, selection, evaluation, loop, LLM, sandbox, tools
- `packages/cli/` — CLI (@evolve/cli): init, run, results commands
- `packages/initial-agent/` — Minimal initial hyperagent (task.ts + meta.ts)

## Testing

`bun test` runs all `*.test.ts` files. Tests live next to the code they test.

## Type Checking

`tsc --noEmit` must pass. Bun strips types at runtime but does not check them.
Run `bunx tsc --noEmit` before considering work done.

## Key Design Decisions

- Branded types (`AgentId`, `RunId`) prevent cross-use of identifiers
- Discriminated union errors (`EvolveError`) for exhaustive handling
- Archive keeps all compiled variants (no pruning, no min score threshold)
- Parent selection: sigmoid + novelty bonus (Appendix A.2)
- Agents get exactly 2 tools: bash + editor
- Evaluator code is hidden from agents (they see scores only)
