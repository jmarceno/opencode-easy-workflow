import { ConfigLoader } from "@aliou/pi-utils-settings";

/**
 * Raw config shape (what gets saved to disk).
 * All fields optional -- only overrides are stored.
 */
export interface EasyWorkflowConfig {
  enabled?: boolean;
  reviewAgent?: string;
  maxReviewRuns?: number;
  reviewCooldownMs?: number;
  port?: number;
  defaultBranch?: string;
  planModel?: string;
  executionModel?: string;
  parallelTasks?: number;
  autoCommit?: boolean;
  deleteWorktree?: boolean;
}

/**
 * Resolved config (defaults merged in).
 * All fields required.
 */
export interface ResolvedEasyWorkflowConfig {
  enabled: boolean;
  reviewAgent: string;
  maxReviewRuns: number;
  reviewCooldownMs: number;
  port: number;
  defaultBranch: string;
  planModel: string;
  executionModel: string;
  parallelTasks: number;
  autoCommit: boolean;
  deleteWorktree: boolean;
}

const DEFAULTS: ResolvedEasyWorkflowConfig = {
  enabled: true,
  reviewAgent: "workflow-review",
  maxReviewRuns: 2,
  reviewCooldownMs: 30_000,
  port: 3847,
  defaultBranch: "main",
  planModel: "default",
  executionModel: "default",
  parallelTasks: 2,
  autoCommit: true,
  deleteWorktree: true,
};

/**
 * Config loader instance.
 * Config is stored at ~/.pi/agent/extensions/easy-workflow.json
 */
export const configLoader = new ConfigLoader<EasyWorkflowConfig, ResolvedEasyWorkflowConfig>(
  "easy-workflow",
  DEFAULTS,
);
