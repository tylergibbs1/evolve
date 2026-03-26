import { test, expect, describe } from "bun:test";
import { BudgetTracker } from "./budget.ts";
import type { BudgetConfig } from "../types.ts";

const defaultConfig: BudgetConfig = {
  maxTokensPerIteration: 1_000_000,
  maxTotalTokens: 10_000_000,
  maxCostUSD: 100,
  pauseOnBudgetExhausted: true,
  warnAtPercentage: 80,
};

describe("BudgetTracker", () => {
  test("starts with zero usage", () => {
    const tracker = new BudgetTracker(defaultConfig, "claude-sonnet-4-20250514");
    const state = tracker.getState();
    expect(state.totalInputTokens).toBe(0);
    expect(state.totalOutputTokens).toBe(0);
    expect(state.estimatedCostUSD).toBe(0);
    expect(state.iterationsCompleted).toBe(0);
  });

  test("records token usage", () => {
    const tracker = new BudgetTracker(defaultConfig, "claude-sonnet-4-20250514");
    tracker.recordUsage(1000, 500);
    const state = tracker.getState();
    expect(state.totalInputTokens).toBe(1000);
    expect(state.totalOutputTokens).toBe(500);
    expect(state.estimatedCostUSD).toBeGreaterThan(0);
  });

  test("accumulates multiple usage recordings", () => {
    const tracker = new BudgetTracker(defaultConfig, "claude-sonnet-4-20250514");
    tracker.recordUsage(1000, 500);
    tracker.recordUsage(2000, 1000);
    const state = tracker.getState();
    expect(state.totalInputTokens).toBe(3000);
    expect(state.totalOutputTokens).toBe(1500);
  });

  test("records iterations", () => {
    const tracker = new BudgetTracker(defaultConfig, "claude-sonnet-4-20250514");
    tracker.recordIteration();
    tracker.recordIteration();
    expect(tracker.getState().iterationsCompleted).toBe(2);
  });

  test("check returns null when within budget", () => {
    const tracker = new BudgetTracker(defaultConfig, "claude-sonnet-4-20250514");
    tracker.recordUsage(1000, 500);
    expect(tracker.check()).toBeNull();
  });

  test("check returns error when tokens exceeded", () => {
    const config: BudgetConfig = { ...defaultConfig, maxTotalTokens: 100 };
    const tracker = new BudgetTracker(config, "claude-sonnet-4-20250514");
    tracker.recordUsage(80, 30);
    const error = tracker.check();
    expect(error).not.toBeNull();
    expect(error!.kind).toBe("budget_exhausted");
  });

  test("check returns error when cost exceeded", () => {
    const config: BudgetConfig = { ...defaultConfig, maxCostUSD: 0.001 };
    const tracker = new BudgetTracker(config, "claude-sonnet-4-20250514");
    tracker.recordUsage(1_000_000, 500_000);
    const error = tracker.check();
    expect(error).not.toBeNull();
    expect(error!.kind).toBe("budget_exhausted");
  });

  test("warning threshold detection", () => {
    const config: BudgetConfig = { ...defaultConfig, maxCostUSD: 100, warnAtPercentage: 50 };
    const tracker = new BudgetTracker(config, "custom", {
      input: 10,
      output: 10,
    });
    // $10/M * 100 tokens = $0.001 — 0.001% of $100, not enough
    tracker.recordUsage(50, 50);
    expect(tracker.isWarningThreshold()).toBe(false);
    // $10/M * 10M tokens = $100 — 100% of $100
    tracker.recordUsage(5_000_000, 5_000_000);
    expect(tracker.isWarningThreshold()).toBe(true);
  });

  test("uses custom pricing", () => {
    const tracker = new BudgetTracker(
      defaultConfig,
      "custom-model",
      { input: 10, output: 30 },
    );
    tracker.recordUsage(1_000_000, 1_000_000);
    // Cost = (1M * 10 + 1M * 30) / 1M = $40
    expect(tracker.getState().estimatedCostUSD).toBe(40);
  });

  test("uses fallback pricing for unknown model", () => {
    const tracker = new BudgetTracker(defaultConfig, "unknown-model-xyz");
    tracker.recordUsage(1_000_000, 1_000_000);
    // Fallback: input=3, output=15 → (3 + 15) = $18
    expect(tracker.getState().estimatedCostUSD).toBe(18);
  });

  test("getState returns a copy", () => {
    const tracker = new BudgetTracker(defaultConfig, "claude-sonnet-4-20250514");
    const state1 = tracker.getState();
    tracker.recordUsage(1000, 500);
    const state2 = tracker.getState();
    // state1 should not have been mutated
    expect(state1.totalInputTokens).toBe(0);
    expect(state2.totalInputTokens).toBe(1000);
  });

  test("check boundary: tokens exactly at limit", () => {
    const config: BudgetConfig = { ...defaultConfig, maxTotalTokens: 1000 };
    const tracker = new BudgetTracker(config, "claude-sonnet-4-20250514");
    tracker.recordUsage(500, 500);
    // 1000 is NOT > 1000, so should pass
    expect(tracker.check()).toBeNull();
  });

  test("check boundary: tokens one over limit", () => {
    const config: BudgetConfig = { ...defaultConfig, maxTotalTokens: 1000 };
    const tracker = new BudgetTracker(config, "claude-sonnet-4-20250514");
    tracker.recordUsage(500, 501);
    expect(tracker.check()).not.toBeNull();
  });
});

describe("BudgetTracker.estimateRunCost", () => {
  test("estimates cost for known model", () => {
    const est = BudgetTracker.estimateRunCost(10, 2, "claude-sonnet-4-20250514", 1);
    expect(est.estimatedTokens).toBeGreaterThan(0);
    expect(est.estimatedCostUSD).toBeGreaterThan(0);
  });

  test("scales with iterations and k", () => {
    const est10 = BudgetTracker.estimateRunCost(10, 2, "claude-sonnet-4-20250514", 1);
    const est100 = BudgetTracker.estimateRunCost(100, 2, "claude-sonnet-4-20250514", 1);
    expect(est100.estimatedCostUSD).toBeCloseTo(est10.estimatedCostUSD * 10, 0);
  });

  test("scales with k", () => {
    const k2 = BudgetTracker.estimateRunCost(10, 2, "claude-sonnet-4-20250514", 1);
    const k4 = BudgetTracker.estimateRunCost(10, 4, "claude-sonnet-4-20250514", 1);
    expect(k4.estimatedCostUSD).toBeCloseTo(k2.estimatedCostUSD * 2, 0);
  });

  test("scales with domain count", () => {
    const d1 = BudgetTracker.estimateRunCost(10, 2, "claude-sonnet-4-20250514", 1);
    const d3 = BudgetTracker.estimateRunCost(10, 2, "claude-sonnet-4-20250514", 3);
    expect(d3.estimatedCostUSD).toBeGreaterThan(d1.estimatedCostUSD);
  });

  test("zero iterations returns zero", () => {
    const est = BudgetTracker.estimateRunCost(0, 2, "claude-sonnet-4-20250514", 1);
    expect(est.estimatedTokens).toBe(0);
    expect(est.estimatedCostUSD).toBe(0);
  });

  test("uses fallback pricing for unknown model", () => {
    const est = BudgetTracker.estimateRunCost(10, 2, "totally-unknown", 1);
    expect(est.estimatedCostUSD).toBeGreaterThan(0);
  });
});
