import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { configLoader } from "./config";
import { startKanbanServer } from "./kanban/runtime";
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
    console.debug("Easy Workflow extension is disabled");
    return;
  }

  console.info("Easy Workflow extension initializing", {
    reviewAgent: config.reviewAgent,
    maxReviewRuns: config.maxReviewRuns,
    port: config.port,
  });

  // Start kanban server
  const kanbanServer = startKanbanServer(pi);
  console.info("Easy Workflow kanban server started", {
    port: kanbanServer.getPort(),
    url: `http://127.0.0.1:${kanbanServer.getPort()}`,
  });

  // Register tools, commands, and hooks
  registerTools(pi);
  registerCommands(pi);
  registerHooks(pi);

  console.info("Easy Workflow extension initialized");
}
