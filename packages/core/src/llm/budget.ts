import type { BudgetConfig, BudgetState, EvolveError } from "../types.ts";

// Pricing per million tokens (USD), March 2026 estimates.
// Users can override via config; these are defaults for cost estimation.
const DEFAULT_PRICING: Record<string, { input: number; output: number }> = {
  "claude-sonnet-4-20250514": { input: 3, output: 15 },
  "claude-opus-4-20250514": { input: 15, output: 75 },
  "claude-haiku-4-5-20251001": { input: 0.8, output: 4 },
  "gpt-4o": { input: 2.5, output: 10 },
  "o3-mini": { input: 1.1, output: 4.4 },
  "o4-mini": { input: 1.1, output: 4.4 },
};

// Fallback pricing for unknown models to avoid repeated object creation
const FALLBACK_PRICING = { input: 3, output: 15 };

export class BudgetTracker {
  private state: BudgetState = {
    totalInputTokens: 0,
    totalOutputTokens: 0,
    estimatedCostUSD: 0,
    iterationsCompleted: 0,
  };

  constructor(
    private config: BudgetConfig,
    private model: string,
    private pricing?: { input: number; output: number },
  ) {
    if (!this.pricing) {
      this.pricing = DEFAULT_PRICING[model] ?? FALLBACK_PRICING;
    }
  }

  recordUsage(inputTokens: number, outputTokens: number): void {
    this.state.totalInputTokens += inputTokens;
    this.state.totalOutputTokens += outputTokens;
    this.state.estimatedCostUSD =
      (this.state.totalInputTokens * this.pricing!.input +
        this.state.totalOutputTokens * this.pricing!.output) /
      1_000_000;
  }

  recordIteration(): void {
    this.state.iterationsCompleted++;
  }

  getState(): Readonly<BudgetState> {
    return { ...this.state };
  }

  /** Returns an error if budget is exhausted, otherwise null. */
  check(): EvolveError | null {
    if (
      this.state.totalInputTokens + this.state.totalOutputTokens >
      this.config.maxTotalTokens
    ) {
      return {
        kind: "budget_exhausted",
        spent: this.state.totalInputTokens + this.state.totalOutputTokens,
        limit: this.config.maxTotalTokens,
      };
    }
    if (this.state.estimatedCostUSD > this.config.maxCostUSD) {
      return {
        kind: "budget_exhausted",
        spent: this.state.estimatedCostUSD,
        limit: this.config.maxCostUSD,
      };
    }
    return null;
  }

  isWarningThreshold(): boolean {
    const percentUsed =
      (this.state.estimatedCostUSD / this.config.maxCostUSD) * 100;
    return percentUsed >= this.config.warnAtPercentage;
  }

  /**
   * Estimate cost for a full run before launching.
   * Based on paper numbers: ~330K tokens per iteration for self-modification.
   */
  static estimateRunCost(
    iterations: number,
    k: number,
    model: string,
    domainsCount: number,
  ): { estimatedTokens: number; estimatedCostUSD: number } {
    const pricing = DEFAULT_PRICING[model] ?? FALLBACK_PRICING;
    // ~330K tokens per modification attempt (paper: 33M / 100 iterations)
    const tokensPerModification = 330_000;
    // ~50K tokens per evaluation (conservative estimate)
    const tokensPerEvaluation = 50_000 * domainsCount;
    const totalTokens =
      iterations * k * (tokensPerModification + tokensPerEvaluation);
    // Assume 70% input, 30% output
    const inputTokens = totalTokens * 0.7;
    const outputTokens = totalTokens * 0.3;
    const estimatedCostUSD =
      (inputTokens * pricing.input + outputTokens * pricing.output) / 1_000_000;

    return { estimatedTokens: totalTokens, estimatedCostUSD };
  }
}
