import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { configLoader } from "../config";

/**
 * Hook for session lifecycle management.
 *
 * Handles:
 * - Session creation (initialization)
 * - Session shutdown (cleanup)
 * - Session switching (state transfer)
 */
export function registerSessionStartHook(pi: ExtensionAPI): void {
  pi.on("session_start", async (_event, ctx) => {
    const config = configLoader.getConfig();

    console.debug("New session started", {
      sessionFile: ctx.sessionManager.getSessionFile?.() ?? null,
      cwd: ctx.cwd,
    });

    // TODO: Initialize workflow state for new session
    // - Check if this is a workflow-owned session
    // - Load any pending workflow context
  });
}

export function registerSessionShutdownHook(pi: ExtensionAPI): void {
  pi.on("session_shutdown", async (_event, _ctx) => {
    console.debug("Session shutdown");

    // TODO: Cleanup workflow state
    // - Close any open workflow runs for this session
    // - Save pending state to disk
  });
}

export function registerSessionSwitchHook(pi: ExtensionAPI): void {
  pi.on("session_switch", async (event, ctx) => {
    console.debug("Session switched", {
      sessionFile: ctx.sessionManager.getSessionFile?.() ?? null,
      reason: event.reason,
    });

    // TODO: Handle workflow state transfer between sessions
  });
}

export function registerSessionForkHook(pi: ExtensionAPI): void {
  pi.on("session_fork", async (_event, ctx) => {
    console.debug("Session forked", {
      originalSessionFile: ctx.sessionManager.getSessionFile?.() ?? null,
    });

    // TODO: Copy workflow context to forked session
  });
}
