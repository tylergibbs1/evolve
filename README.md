# Evolve

Metacognitive self-improving agent framework. TypeScript implementation of the [Darwin Godel Machine with Hyperagents (DGM-H)](https://arxiv.org/abs/2603.19461).

The system maintains an archive of self-modifying agent programs. Each agent contains a task-solving component and a meta component that modifies itself and other agents. The meta component itself is editable — enabling metacognitive self-modification. Over time, agents improve both at solving tasks and at generating improvements.

The underlying LLM stays frozen. All gains come from evolving the code that wraps it.

## How it works

```
┌─────────────────────────────────────────────────────┐
│                   Evolution Loop                     │
│                                                     │
│  1. Select parent(s) from archive                   │
│  2. Meta agent modifies parent → child variant      │
│  3. Evaluate child on task domain                   │
│  4. Add child to archive (every compiled variant)   │
│  5. Repeat                                          │
│                                                     │
│  Parent selection: sigmoid + novelty bonus           │
│  Archive: keeps everything (stepping stones matter)  │
│  Evaluation: staged (cheap screen → full eval)       │
└─────────────────────────────────────────────────────┘
```

The initial agent is deliberately minimal — a single LLM call with a generic prompt. The meta agent's only instruction is "modify any part of the codebase." From this starting point, agents autonomously discover prompt engineering, field-specific extraction strategies, output validation, and other improvements.

## Quick start

```bash
bun install
```

### Initialize a project

```bash
bun packages/cli/src/index.ts init my-project
cd my-project
```

This creates:
- `agent/task.ts` — initial task agent (minimal single LLM call)
- `agent/meta.ts` — initial meta agent ("modify the codebase")
- `eval/config.ts` — evaluation configuration (customize this)
- `evolve.config.ts` — run configuration

### Define your evaluation domain

Edit `eval/config.ts` with your task cases and scorer:

```typescript
const domain: DomainConfig = {
  name: "my-task",
  trainCases: [
    { id: "1", input: { text: "..." }, expected: { answer: "..." } },
    // ...
  ],
  testCases: [...],  // held out, only for final eval
  scorer: async (output, expected) => {
    // Return 0-1 score
    return output === expected.expected ? 1 : 0;
  },
};
```

### Run evolution

```bash
export ANTHROPIC_API_KEY=sk-ant-...
bun packages/cli/src/index.ts run --iterations 10 --k 2
```

### View results

```bash
bun packages/cli/src/index.ts results
```

## Real-world example

The `examples/data-extraction/` directory contains a complete scenario: extracting structured data (name, email, company, role) from messy unstructured text.

```bash
bun run examples/data-extraction/run.ts
```

Results from a 3-iteration run:

```
Initial agent:  0.659  (generic "You are an agent" prompt)
Best evolved:   0.982  (specialized extraction with field-specific guidelines)

Improvement:    +0.323 (49.0% relative improvement)
```

The meta agent autonomously discovered:
- Field-specific extraction instructions
- Pattern hints for names, emails, companies, roles
- Structured output schema with all 4 required fields

## Architecture

### From the papers

Based on two ICLR 2026 papers:
- **[HyperAgents](https://arxiv.org/abs/2603.19461)** (Zhang et al.) — metacognitive self-modification, cross-domain transfer
- **[Darwin Godel Machine](https://arxiv.org/abs/2505.22954)** (Zhang et al.) — open-ended self-improvement, archive design, staged evaluation

### Core components

| Component | Description |
|-----------|-------------|
| **Archive** | SQLite-backed store of every compiled agent variant. No pruning, no minimum score — low-scoring variants serve as stepping stones. |
| **Parent Selection** | Sigmoid + novelty bonus (Appendix A.2). Balances exploitation of high scorers with exploration of under-sampled agents. |
| **Staged Evaluation** | Multi-tier: cheap screen → full eval. Only top candidates get expensive evaluation. |
| **Tools** | Agents get exactly 2 tools: `bash` and `editor`. The papers proved these sufficient for agents to build whatever infrastructure they need. |
| **Hidden Evaluator** | Agents see scores, never scoring code. Prevents objective hacking (DGM Appendix H). |
| **Editable Selection** | Meta agent can modify its own parent selection strategy — the key metacognitive feature. |
| **Invalid Parent Marking** | Parents whose children consistently fail compilation are marked invalid and skipped. |
| **Protected Paths** | Evaluation files are restored after the meta agent runs, preventing metric gaming. |

### Project structure

```
packages/
├── core/src/
│   ├── types.ts          — Branded IDs, discriminated errors, all interfaces
│   ├── archive.ts        — bun:sqlite archive (WAL mode)
│   ├── selection.ts      — Parent selection (sigmoid + novelty)
│   ├── evaluate.ts       — Multi-tier staged evaluation
│   ├── loop.ts           — Algorithm 1: evolution loop with k parallel parents
│   ├── feedback.ts       — Meta agent prompt construction
│   ├── metrics.ts        — improvement@k, score progression, lineage tree
│   ├── llm/
│   │   ├── provider.ts   — LLM interface + agentic tool-use loop
│   │   ├── anthropic.ts  — Anthropic SDK adapter (tool_choice support)
│   │   └── budget.ts     — Token/cost tracking
│   ├── sandbox/
│   │   └── subprocess.ts — L1: Bun subprocess sandbox
│   └── tools/
│       ├── bash.ts       — Scoped bash tool (Bun.spawn with timeout)
│       └── editor.ts     — Scoped file editor (view/create/replace/insert/undo)
├── cli/src/              — evolve init | run | results
└── initial-agent/        — Minimal starting agent (task.ts, meta.ts, select_parent.ts)
```

## Key design decisions

**Matches the papers:**
- Initial agent is minimal — single LLM call for task, "modify the codebase" for meta
- Archive keeps everything — no pruning, no minimum score threshold
- Parent selection is fixed by default (configurable to editable)
- Evaluation is hidden — agent sees scores only, never scoring implementation
- k parallel parents per iteration
- Task agent output uses forced tool calls for structured JSON (no parsing)

**Diverges from the papers:**
- TypeScript on Bun instead of Python (Bun runs .ts natively, zero build step)
- Anthropic SDK with `tool_choice` for structured output instead of regex parsing
- Three new features from HyperAgents analysis: invalid parent marking, protected paths, editable selection

## Configuration

```typescript
const config: RunConfig = {
  iterations: 10,           // Evolution iterations
  k: 2,                     // Parallel parents per iteration
  topM: 3,                  // Top-m for selection midpoint
  lambda: 10,               // Sigmoid sharpness
  protectedPaths: [],       // Paths to restore after meta agent
  editableSelection: false, // Allow agent to edit selection strategy
  llm: {
    diagnosis:    { provider: "anthropic", model: "claude-sonnet-4-20250514", temperature: 0 },
    modification: { provider: "anthropic", model: "claude-sonnet-4-20250514", temperature: 0 },
    evaluation:   { provider: "anthropic", model: "claude-sonnet-4-20250514", temperature: 0 },
  },
  budget: {
    maxCostUSD: 500,
    pauseOnBudgetExhausted: true,
    warnAtPercentage: 80,
  },
};
```

## Testing

```bash
bun test                          # 168 unit tests + 10 feature tests
bun test packages/core/src/integration.test.ts  # real LLM integration tests
bunx tsc --noEmit                 # type checking (required — Bun strips types)
```

## Cost estimates

| Domain type | Est. cost per 100-iteration run |
|-------------|--------------------------------|
| Classification / grading | $300-500 |
| Simple code generation | $500-2,000 |
| Complex code editing | $10,000-25,000 |

The CLI displays estimated costs before launching a run.

## Tech stack

| Component | Technology |
|-----------|-----------|
| Language | TypeScript (strict mode) |
| Runtime | Bun |
| Archive | bun:sqlite (WAL mode) |
| LLM | @anthropic-ai/sdk |
| CLI | Commander.js |
| Testing | bun test |

## Papers

- Zhang et al. "HyperAgents: LLM Agents with Metacognitive Self-Improvement." ICLR 2026. [arXiv:2603.19461](https://arxiv.org/abs/2603.19461)
- Zhang et al. "Darwin Godel Machine: Open-Ended Evolution of Self-Improving Agents." ICLR 2026. [arXiv:2505.22954](https://arxiv.org/abs/2505.22954)

## License

MIT
