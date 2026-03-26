/**
 * Core types for the Evolve framework.
 *
 * Branded IDs prevent accidental cross-use of identifiers.
 * Discriminated union errors enable exhaustive switch-based handling.
 * All public interfaces are documented for SDK consumers.
 */

// ---------------------------------------------------------------------------
// Branded IDs
// ---------------------------------------------------------------------------

/** Unique identifier for an agent variant in the archive. */
export type AgentId = string & { readonly __brand: "AgentId" };

/** Unique identifier for an evolution run. */
export type RunId = string & { readonly __brand: "RunId" };

export function agentId(raw: string): AgentId {
  return raw as AgentId;
}

export function runId(raw: string): RunId {
  return raw as RunId;
}

// ---------------------------------------------------------------------------
// LLM
// ---------------------------------------------------------------------------

/** A single message in a chat conversation. */
export interface Message {
  role: "user" | "assistant" | "system";
  content: string | MessageContent[];
}

export type MessageContent =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: string };

/** Response from an LLM chat call. */
export interface LLMResponse {
  content: string;
  toolCalls: ToolCall[];
  usage: { inputTokens: number; outputTokens: number };
}

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/** Tool definition passed to the LLM. */
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/**
 * Controls which tool the LLM uses.
 * - `"auto"` — LLM decides (default)
 * - `"any"` — LLM must use some tool
 * - `{ tool: "name" }` — force a specific tool (structured output pattern)
 */
export type ToolChoice =
  | "auto"
  | "any"
  | { tool: string };

/** Three-role LLM configuration (diagnosis / modification / evaluation). */
export interface LLMRoleConfig {
  provider: "anthropic" | "openai";
  model: string;
  temperature: number;
}

export interface LLMConfig {
  /** Analyzes eval logs, proposes what to improve (reasoning-heavy). */
  diagnosis: LLMRoleConfig;
  /** Implements the proposed improvement (coding-heavy). */
  modification: LLMRoleConfig;
  /** Runs the task for evaluation (domain-dependent). */
  evaluation: LLMRoleConfig;
}

// ---------------------------------------------------------------------------
// Tools — The two tools agents receive (Appendix A.1)
// ---------------------------------------------------------------------------

export interface BashTool {
  run(command: string): Promise<BashResult>;
}

export interface BashResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface EditorTool {
  view(path: string, range?: [number, number]): Promise<string>;
  create(path: string, content: string): Promise<void>;
  replace(path: string, oldStr: string, newStr: string): Promise<void>;
  insert(path: string, line: number, content: string): Promise<void>;
  undo(path: string): Promise<void>;
}

export interface LLMTool {
  chat(messages: Message[], tools?: ToolDefinition[]): Promise<LLMResponse>;
}

/** The complete tool set available to a hyperagent. */
export interface Tools {
  llm: LLMTool;
  bash: BashTool;
  editor: EditorTool;
}

// ---------------------------------------------------------------------------
// Sandbox
// ---------------------------------------------------------------------------

export interface ResourceLimits {
  /** Max wall-clock time in seconds. Default: 300 (5 min). */
  maxWallTimeSeconds: number;
  /** Max memory in MB. Default: 512. */
  maxMemoryMB: number;
  /** Max LLM calls per evaluation. Default: 50. */
  maxLLMCalls: number;
  /** Network access policy. */
  networkAccess: "none" | "llm-only";
}

export interface SandboxResult {
  success: boolean;
  output: string;
  error?: string;
  exitCode: number;
  wallTimeSeconds: number;
  llmCallsUsed: number;
}

export interface Sandbox {
  /**
   * Execute an agent variant in isolation.
   *
   * @example
   * ```ts
   * const result = await sandbox.run(repoPath, "task.ts", tools, limits);
   * ```
   */
  run(
    repoPath: string,
    entrypoint: string,
    tools: Tools,
    limits: ResourceLimits,
  ): Promise<SandboxResult>;
}

// ---------------------------------------------------------------------------
// Archive
// ---------------------------------------------------------------------------

/** Score for a single evaluation domain. */
export interface DomainScore {
  domain: string;
  trainScore: number;
  validationScore: number | null;
  testScore: number | null;
}

/**
 * A single entry in the archive.
 *
 * Every compiled variant enters the archive — there is no minimum score
 * threshold. Low-scoring variants may serve as stepping stones for future
 * improvement (DGM Section 3).
 */
export interface ArchiveEntry {
  id: AgentId;
  parentId: AgentId | null;
  generation: number;
  repoSnapshot: string;
  scores: DomainScore[];
  compiledChildrenCount: number;
  /**
   * Whether this agent is a valid parent for future generations.
   * Set to false when all children of this agent fail compilation,
   * preventing wasted iterations on consistently broken lineages.
   */
  validParent: boolean;
  metadata: {
    createdAt: Date;
    diffFromParent: string;
  };
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

/** A single evaluation case (input + expected output). */
export interface EvalCase {
  id: string;
  input: unknown;
  expected: unknown;
}

/** What the agent sees after evaluation — scores only, never scoring code. */
export interface EvalFeedback {
  domain: string;
  score: number;
  feedback?: string;
}

export interface EvalStage {
  /** How many tasks at this stage. */
  taskCount: number;
  /** Minimum score to proceed to next stage. */
  passThreshold: number;
  /** 'rate' = % above threshold, 'any' = at least 1 success. */
  passCondition: "rate" | "any";
  /** Only proceed if agent is in top-N of archive. */
  archiveRankRequired?: number;
}

export interface StagedEvalConfig {
  stages: EvalStage[];
  /** Score assigned to tasks not evaluated (usually 0). */
  defaultScore: number;
}

export interface DomainConfig {
  name: string;
  trainCases: EvalCase[];
  validationCases?: EvalCase[];
  testCases: EvalCase[];
  scorer: (output: unknown, expected: EvalCase) => Promise<number>;
}

export interface EvalConfig {
  domains: DomainConfig[];
  stagedEval: StagedEvalConfig;
  /** Use validation scores for parent selection when available. */
  parentSelectionScore: "validation" | "training";
}

// ---------------------------------------------------------------------------
// Meta Agent Context
// ---------------------------------------------------------------------------

/** Context passed to the meta agent for self-modification. */
export interface MetaContext {
  repoPath: string;
  evalHistory: EvalFeedback[];
  archiveSummary: ArchiveSummary;
  remainingIterations: number;
}

export interface ArchiveSummary {
  totalAgents: number;
  bestScore: number;
  averageScore: number;
  topAgents: Array<{ id: AgentId; score: number; generation: number }>;
}

// ---------------------------------------------------------------------------
// Budget
// ---------------------------------------------------------------------------

export interface BudgetConfig {
  maxTokensPerIteration: number;
  maxTotalTokens: number;
  maxCostUSD: number;
  pauseOnBudgetExhausted: boolean;
  warnAtPercentage: number;
}

export interface BudgetState {
  totalInputTokens: number;
  totalOutputTokens: number;
  estimatedCostUSD: number;
  iterationsCompleted: number;
}

// ---------------------------------------------------------------------------
// Run Configuration
// ---------------------------------------------------------------------------

export interface RunConfig {
  llm: LLMConfig;
  eval: EvalConfig;
  budget: BudgetConfig;
  sandbox: {
    limits: ResourceLimits;
  };
  /** Number of evolution iterations. */
  iterations: number;
  /** Parallel parents per iteration (DGM: 2-4). */
  k: number;
  /** Top-m for parent selection dynamic midpoint. */
  topM: number;
  /** Sigmoid sharpness for parent selection. */
  lambda: number;
  /** Path to the initial agent directory. */
  initialAgentPath: string;
  /** Output directory for the archive. */
  outputDir: string;
  /**
   * Paths within the agent repo that are reset after the meta agent runs.
   * Prevents the meta agent from modifying evaluation harnesses or domain configs.
   * Relative to the agent repo root. Default: [].
   */
  protectedPaths: string[];
  /**
   * When true, parent selection runs the agent's own `select_parent.ts` inside
   * the sandbox instead of the fixed sigmoid+novelty algorithm.
   * The meta agent can edit `select_parent.ts` to evolve its own selection strategy.
   * Default: false.
   */
  editableSelection: boolean;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type EvolveError =
  | { kind: "budget_exhausted"; spent: number; limit: number }
  | { kind: "sandbox_timeout"; agentId: AgentId; wallTimeSeconds: number }
  | { kind: "sandbox_crash"; agentId: AgentId; stderr: string }
  | { kind: "eval_failed"; agentId: AgentId; domain: string; reason: string }
  | { kind: "llm_error"; provider: string; status: number; message: string }
  | { kind: "compile_error"; agentId: AgentId; stderr: string };

export class EvolveException extends Error {
  constructor(public readonly error: EvolveError) {
    super(formatEvolveError(error));
    this.name = "EvolveException";
  }
}

function formatEvolveError(e: EvolveError): string {
  switch (e.kind) {
    case "budget_exhausted":
      return `Budget exhausted: spent $${e.spent.toFixed(2)}, limit $${e.limit.toFixed(2)}`;
    case "sandbox_timeout":
      return `Sandbox timeout for agent ${e.agentId}: ${e.wallTimeSeconds}s`;
    case "sandbox_crash":
      return `Sandbox crash for agent ${e.agentId}: ${e.stderr}`;
    case "eval_failed":
      return `Evaluation failed for agent ${e.agentId} on ${e.domain}: ${e.reason}`;
    case "llm_error":
      return `LLM error (${e.provider}): ${e.status} ${e.message}`;
    case "compile_error":
      return `Compile error for agent ${e.agentId}: ${e.stderr}`;
  }
}

// ---------------------------------------------------------------------------
// Events — for logging and dashboard integration
// ---------------------------------------------------------------------------

export type EvolveEvent =
  | { type: "iteration_start"; iteration: number; parentIds: AgentId[] }
  | { type: "iteration_end"; iteration: number; newAgentIds: AgentId[] }
  | { type: "agent_created"; agentId: AgentId; parentId: AgentId; generation: number }
  | { type: "eval_complete"; agentId: AgentId; scores: DomainScore[] }
  | { type: "eval_staged_skip"; agentId: AgentId; stage: number; reason: string }
  | { type: "budget_warning"; percentUsed: number; estimatedCostUSD: number }
  | { type: "run_complete"; bestAgentId: AgentId; bestScore: number; totalIterations: number };

export type EventListener = (event: EvolveEvent) => void;
