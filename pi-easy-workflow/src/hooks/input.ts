import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { configLoader } from "../config";
import { parseWorkflowPrompt } from "../utils/workflow-parser";

const WORKFLOW_MARKER = "#workflow";

/**
 * Hook for detecting #workflow prefix in user input.
 *
 * When a user types "#workflow <task>", this activates the review-driven workflow.
 */
export function registerInputHook(pi: ExtensionAPI): void {
  pi.on("input", async (event, ctx) => {
    const { text } = event;
    const { valid, cleanedPrompt } = parseWorkflowPrompt(text);

    if (!valid || !cleanedPrompt) {
      return { action: "continue" };
    }

    // Workflow activation requested
    ctx.ui.notify("Workflow mode enabled", "info");

    // TODO: Implement workflow activation logic
    // - Extract goals from cleanedPrompt
    // - Create workflow run state
    // - Set up review triggers
    // - Update system context

    return { action: "continue" };
  });
}

/**
 * Hook for transforming input that starts with #workflow.
 * Removes the #workflow marker and passes the cleaned prompt through.
 */
export function registerInputTransformer(pi: ExtensionAPI): void {
  pi.on("input", async (event) => {
    const text = event.text.trim();
    const tokens = text.split(/\s+/);
    const firstToken = tokens[0];
    const lastToken = tokens[tokens.length - 1];

    // Check if #workflow marker is at start or end
    if (firstToken === WORKFLOW_MARKER) {
      const cleaned = tokens.slice(1).join(" ");
      return cleaned ? { action: "transform", text: cleaned, images: event.images } : { action: "continue" };
    }

    if (lastToken === WORKFLOW_MARKER) {
      const cleaned = tokens.slice(0, -1).join(" ");
      return cleaned ? { action: "transform", text: cleaned, images: event.images } : { action: "continue" };
    }

    return { action: "continue" };
  });
}
