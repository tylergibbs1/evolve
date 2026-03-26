export type { Sandbox, SandboxResult, ResourceLimits } from "../types.ts";

export const DEFAULT_RESOURCE_LIMITS = {
  maxWallTimeSeconds: 300,
  maxMemoryMB: 512,
  maxLLMCalls: 50,
  networkAccess: "llm-only" as const,
} satisfies import("../types.ts").ResourceLimits;
