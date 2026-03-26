import type {
  AgentId,
  ArchiveEntry,
  DomainConfig,
  DomainScore,
  EvalCase,
  EvalFeedback,
  StagedEvalConfig,
} from "./types.ts";
import { getAverageScore } from "./selection.ts";

/**
 * Multi-tier staged evaluation framework.
 *
 * Evaluates an agent on progressively larger task subsets, stopping early
 * if it fails to meet the threshold at any stage. This is the key cost
 * optimization from the DGM paper (Section 4.2).
 *
 * The evaluator code is never exposed to the agent. The agent only sees
 * the resulting EvalFeedback (scores + optional feedback text).
 */
export async function evaluateAgent(
  agentId: AgentId,
  runTask: (evalCase: EvalCase, domain: string) => Promise<unknown>,
  domains: DomainConfig[],
  stagedEval: StagedEvalConfig,
  archive: readonly ArchiveEntry[],
): Promise<{ scores: DomainScore[]; feedback: EvalFeedback[] }> {
  const scores: DomainScore[] = [];
  const feedback: EvalFeedback[] = [];

  for (const domain of domains) {
    const result = await evaluateDomain(
      agentId,
      runTask,
      domain,
      stagedEval,
      archive,
    );
    scores.push(result.score);
    feedback.push(result.feedback);
  }

  return { scores, feedback };
}

async function evaluateDomain(
  _agentId: AgentId,
  runTask: (evalCase: EvalCase, domain: string) => Promise<unknown>,
  domain: DomainConfig,
  config: StagedEvalConfig,
  archive: readonly ArchiveEntry[],
): Promise<{ score: DomainScore; feedback: EvalFeedback }> {
  const trainCases = [...domain.trainCases];
  shuffle(trainCases);

  let evaluatedCount = 0;
  let totalScore = 0;

  for (let stageIdx = 0; stageIdx < config.stages.length; stageIdx++) {
    const stage = config.stages[stageIdx]!;

    // Check archive rank requirement
    if (stage.archiveRankRequired !== undefined) {
      const sorted = [...archive].sort(
        (a, b) => getAverageScore(b) - getAverageScore(a),
      );
      const currentScore =
        evaluatedCount > 0 ? totalScore / evaluatedCount : 0;
      const rank = sorted.filter(
        (e) => getAverageScore(e) > currentScore,
      ).length;
      if (rank >= stage.archiveRankRequired) {
        break; // Not in top-N, skip remaining stages
      }
    }

    // Determine task subset for this stage
    const stageEnd = Math.min(stage.taskCount, trainCases.length);
    const stageCases = trainCases.slice(evaluatedCount, stageEnd);

    // Evaluate each case in this stage
    for (const evalCase of stageCases) {
      try {
        const output = await runTask(evalCase, domain.name);
        const caseScore = await domain.scorer(output, evalCase);
        totalScore += caseScore;
      } catch {
        totalScore += config.defaultScore;
      }
      evaluatedCount++;
    }

    // Check pass condition
    const currentRate = evaluatedCount > 0 ? totalScore / evaluatedCount : 0;
    const passed =
      stage.passCondition === "any"
        ? totalScore > 0
        : currentRate >= stage.passThreshold;

    if (!passed && stageIdx < config.stages.length - 1) {
      // Failed this stage — assign default score for remaining tasks
      const remaining = trainCases.length - evaluatedCount;
      totalScore += remaining * config.defaultScore;
      evaluatedCount = trainCases.length;
      break;
    }
  }

  // Fill in remaining cases with default score if not all evaluated
  if (evaluatedCount < trainCases.length) {
    const remaining = trainCases.length - evaluatedCount;
    totalScore += remaining * config.defaultScore;
    evaluatedCount = trainCases.length;
  }

  const trainScore = evaluatedCount > 0 ? totalScore / evaluatedCount : 0;

  // Evaluate validation set if present
  let validationScore: number | null = null;
  if (domain.validationCases && domain.validationCases.length > 0) {
    let valTotal = 0;
    for (const evalCase of domain.validationCases) {
      try {
        const output = await runTask(evalCase, domain.name);
        valTotal += await domain.scorer(output, evalCase);
      } catch {
        valTotal += config.defaultScore;
      }
    }
    validationScore = valTotal / domain.validationCases.length;
  }

  return {
    score: {
      domain: domain.name,
      trainScore,
      validationScore,
      testScore: null, // Test scores only at final evaluation
    },
    feedback: {
      domain: domain.name,
      score: validationScore ?? trainScore,
    },
  };
}

/** Fisher-Yates shuffle (in-place). */
function shuffle<T>(arr: T[]): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j]!, arr[i]!];
  }
}
