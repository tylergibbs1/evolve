<p align="center">
  <img src="logo.webp" width="200" alt="Evolve">
</p>

<h1 align="center">Evolve</h1>

<p align="center">
  Metacognitive self-improving agent framework.<br>
  TypeScript implementation of the <a href="https://arxiv.org/abs/2603.19461">Darwin Godel Machine with Hyperagents (DGM-H)</a>.
</p>

The system maintains an archive of self-modifying agent programs. Each agent contains a task-solving component and a meta component that modifies itself and other agents. The meta component itself is editable — enabling metacognitive self-modification. Over time, agents improve both at solving tasks and at generating improvements.

The underlying LLM stays frozen. All gains come from evolving the code that wraps it.

Mechanically, this implementation follows the DGM-H pattern from the paper: archive-based parent selection, code-level self-modification, staged evaluation, and reinsertion of compiled children as future stepping stones. The included `experiment*.ts` files are lightweight framework demos, not reproductions of the paper's published benchmark suites or reported numbers.

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
  // Optional: constrain output format via Anthropic structured outputs
  outputSchema: {
    type: "object",
    properties: {
      answer: { type: "string" },
    },
    required: ["answer"],
    additionalProperties: false,
  },
};
```

When `outputSchema` is provided, the LLM is constrained via `output_config.format` to return valid JSON matching the schema. This prevents the meta agent from accidentally breaking the output format during evolution.

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
| **Staged Evaluation** | Multi-tier: fixed ordered screen → full eval. Only top candidates get expensive evaluation. |
| **Tools** | Agents get exactly 2 tools: `bash` and `editor`. The papers proved these sufficient for agents to build whatever infrastructure they need. |
| **Structured Outputs** | Optional `outputSchema` on domains uses Anthropic's `output_config.format` to guarantee valid JSON, eliminating format breakage during evolution. |
| **Per-Case Feedback** | Evaluator populates `EvalFeedback.feedback` with per-case pass/fail diagnostics so the meta agent can make targeted improvements. |
| **Hidden Evaluator** | Agents see scores and per-case results, never scoring code. Prevents objective hacking (DGM Appendix H). |
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

**Matches the papers at the mechanism level:**
- Initial agent is minimal — single LLM call for task, "modify the codebase" for meta
- Archive keeps everything — no pruning, no minimum score threshold
- Parent selection is fixed by default (configurable to editable)
- `parentSelectionScore` is honored end-to-end (`"validation"` or `"training"`)
- Evaluation is hidden — agent sees scores only, never scoring implementation
- k parallel parents per iteration
- Task agent output uses forced tool calls for structured JSON (no parsing)

**Diverges from the papers in implementation and experiment setup:**
- TypeScript on Bun instead of Python (Bun runs .ts natively, zero build step)
- Anthropic SDK with `tool_choice` for structured output instead of regex parsing; optional `output_config.format` for schema-constrained responses
- Per-case evaluation feedback threaded through to the meta agent
- Four new features from HyperAgents analysis: invalid parent marking, protected paths, editable selection, structured outputs
- Experiment helpers are framework demos, not reproductions of the paper's published benchmark suites

## What This Proves

This repo demonstrates that the agent actually evolves in the DGM-H sense:
- parent agents are sampled from an archive
- the meta agent edits agent code, not just prompts in memory
- compiled children are evaluated and archived
- later generations can branch from earlier stepping stones

What it does **not** prove by itself:
- the exact quantitative results reported in HyperAgents
- apples-to-apples comparisons with the paper's domains, models, budgets, or transfer experiments

To claim reproduction of the paper's results, you would still need to recreate the paper's task suites, evaluation protocols, model choices, iteration counts, and analysis pipeline.

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
    diagnosis:    { provider: "anthropic", model: "claude-opus-4-6", temperature: 0 },
    modification: { provider: "anthropic", model: "claude-opus-4-6", temperature: 0 },
    evaluation:   { provider: "anthropic", model: "claude-opus-4-6", temperature: 0 },
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
bun test                          # 194 tests (unit + feature + integration)
bunx tsc --noEmit                 # type checking (required — Bun strips types)
```

Test coverage: 99.67% line coverage across all core modules.

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

## Experiment findings

We ran 20+ experiments across 6 task domains (data extraction, entity resolution, constraint satisfaction, data normalization, code generation, logic puzzles) with Opus 4.6, Sonnet 4.6, and Haiku 4.5.

### What works

- **Specification discovery**: Given one example of correct output and per-case scoring, the meta agent reverse-engineers format conventions (date formats, phone standards, currency codes, name normalization rules) and jumps from 0.54 → 1.00 in a single generation.
- **Structured outputs eliminate format breakage**: Adding `outputSchema` to a domain prevents the #1 failure mode — meta agents accidentally changing the output structure. With schema constraints, even a vague "You are an agent" prompt produces valid structured JSON.

### What doesn't work

- **Coarse feedback kills evolution**: When the meta agent only sees an aggregate score (e.g., `score: 0.542` for 6 records), it can't diagnose what's failing and makes zero modifications. The same task with per-case feedback solves instantly. Feedback granularity is the primary bottleneck.
- **No iterative refinement**: In every successful case, improvement happened in generation 1. Generations 2-5 never improved further. The multi-generation evolution loop adds no value over a single meta-agent rewrite.
- **Prompt evolution can't overcome model capability limits**: For reasoning tasks (Knights & Knaves logic puzzles), the meta agent generates excellent prompts (exhaustive case enumeration, formal logic rules) but neither Opus nor Haiku improves from them. The bottleneck is model reasoning capacity, not prompt quality.
- **Strong baselines leave no headroom**: Opus 4.6 scores 0.95-1.0 on most tasks with any reasonable prompt. Evolution has nothing to optimize.

### Implications

The framework is most useful for **format/specification discovery** tasks where the agent needs to learn conventions from scoring feedback — not for capability amplification. For evolution to work, you need: (1) granular per-case feedback, (2) a genuine performance gradient, and (3) tasks where better prompting actually helps.

## Papers

- Zhang et al. "HyperAgents: LLM Agents with Metacognitive Self-Improvement." ICLR 2026. [arXiv:2603.19461](https://arxiv.org/abs/2603.19461)
- Zhang et al. "Darwin Godel Machine: Open-Ended Evolution of Self-Improving Agents." ICLR 2026. [arXiv:2505.22954](https://arxiv.org/abs/2505.22954)

## License

MIT
