import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { Task } from "./types";
import { KanbanDB } from "./db";

export type OrchestratorState =
  | "idle"
  | "planning"
  | "waiting_approval"
  | "building"
  | "reviewing"
  | "repairing"
  | "done"
  | "failed"
  | "stuck";

export class Orchestrator {
  private readonly db: KanbanDB;
  private readonly pi?: ExtensionAPI;
  private readonly states = new Map<string, OrchestratorState>();

  constructor(db: KanbanDB, pi?: ExtensionAPI) {
    this.db = db;
    this.pi = pi;
  }

  getState(taskId: string): OrchestratorState {
    return this.states.get(taskId) ?? "idle";
  }

  async startTask(taskId: string): Promise<Task> {
    const task = this.requireTask(taskId);
    if (task.planmode) {
      this.states.set(taskId, "planning");
      return this.updateTask(taskId, {
        status: "review",
        executionPhase: task.executionPhase === "plan_revision_pending"
          ? "plan_complete_waiting_approval"
          : "plan_complete_waiting_approval",
        awaitingPlanApproval: true,
        errorMessage: null,
      });
    }

    this.states.set(taskId, "building");
    return this.updateTask(taskId, {
      status: "executing",
      executionPhase: "implementation_pending",
      awaitingPlanApproval: false,
      errorMessage: null,
    });
  }

  async approvePlan(taskId: string): Promise<Task> {
    this.states.set(taskId, "building");
    return this.updateTask(taskId, {
      status: "executing",
      executionPhase: "implementation_pending",
      awaitingPlanApproval: false,
      errorMessage: null,
    });
  }

  async requestPlanRevision(taskId: string, feedback: string): Promise<Task> {
    const task = this.requireTask(taskId);
    this.states.set(taskId, "waiting_approval");
    const currentOutput = task.agentOutput?.trim() ?? "";
    const revisionNote = `[user-revision-request]\n${feedback.trim()}\n[/user-revision-request]`;
    return this.updateTask(taskId, {
      status: "review",
      executionPhase: "plan_revision_pending",
      awaitingPlanApproval: true,
      planRevisionCount: (task.planRevisionCount ?? 0) + 1,
      agentOutput: currentOutput ? `${currentOutput}\n\n${revisionNote}` : revisionNote,
    });
  }

  async markBuildComplete(taskId: string, agentOutput?: string): Promise<Task> {
    const task = this.requireTask(taskId);
    if (task.review) {
      this.states.set(taskId, "reviewing");
      return this.updateTask(taskId, {
        status: "review",
        executionPhase: "implementation_done",
        agentOutput: agentOutput ?? task.agentOutput,
      });
    }

    this.states.set(taskId, "done");
    return this.updateTask(taskId, {
      status: "done",
      executionPhase: "implementation_done",
      agentOutput: agentOutput ?? task.agentOutput,
    });
  }

  async markReviewPass(taskId: string, summary?: string): Promise<Task> {
    this.states.set(taskId, "done");
    return this.updateTask(taskId, {
      status: "done",
      executionPhase: "implementation_done",
      errorMessage: summary ?? null,
    });
  }

  async markReviewFail(taskId: string, gaps: string[]): Promise<Task> {
    const task = this.requireTask(taskId);
    this.states.set(taskId, "repairing");
    return this.updateTask(taskId, {
      status: "executing",
      reviewCount: (task.reviewCount ?? 0) + 1,
      errorMessage: gaps.join("\n"),
    });
  }

  async cancelTask(taskId: string, reason = "Cancelled"): Promise<Task> {
    this.states.set(taskId, "failed");
    return this.updateTask(taskId, {
      status: "failed",
      errorMessage: reason,
    });
  }

  private requireTask(taskId: string): Task {
    const task = this.db.getTask(taskId);
    if (!task) throw new Error(`Task ${taskId} not found`);
    return task;
  }

  private updateTask(taskId: string, updates: Partial<Task>): Task {
    const updated = this.db.updateTask(taskId, updates);
    if (!updated) throw new Error(`Task ${taskId} not found`);
    console.debug("orchestrator task transition", { taskId, state: this.getState(taskId), updates });
    return updated;
  }
}
