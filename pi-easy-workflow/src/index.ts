import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { configLoader } from "./config";
import { registerTools } from "./tools";
import { registerCommands } from "./commands";
import { registerHooks } from "./hooks";

/**
 * Easy Workflow Extension
 *
 * Provides review-driven workflow with kanban board management.
 *
 * Key features:
 * - `#workflow` prefix to start a review-driven task
 * - Kanban board for task management
 * - Automatic review after task completion
 * - Multi-agent support (plan, build, review, repair)
 */
export default async function (pi: ExtensionAPI) {
  await configLoader.load();
  const config = configLoader.getConfig();

  if (!config.enabled) {
    pi.logger.debug("Easy Workflow extension is disabled");
    return;
  }

  pi.logger.info("Easy Workflow extension initializing", {
    reviewAgent: config.reviewAgent,
    maxReviewRuns: config.maxReviewRuns,
    port: config.port,
  });

  // Register tools, commands, and hooks
  registerTools(pi);
  registerCommands(pi);
  registerHooks(pi);

  pi.logger.info("Easy Workflow extension initialized");
}
