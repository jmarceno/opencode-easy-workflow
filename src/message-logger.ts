/**
 * Message Logger Service
 * 
 * Processes OpenCode events and extracts message data for storage.
 * Handles message parsing, diff generation for file edits, and
 * prepares data for the session_messages table.
 */

import type { KanbanDB } from "./db"
import type { CreateSessionMessageInput, MessageRole, MessageType } from "./types"

export interface MessageLoggerContext {
  db: KanbanDB
  taskId?: string | null
  taskRunId?: string | null
  workflowPhase?: string | null
  sessionStatus?: string | null
}

export interface ParsedMessage {
  sessionId: string
  role: MessageRole
  messageType: MessageType
  content: Record<string, any>
  metadata: {
    messageId?: string | null
    modelProvider?: string | null
    modelId?: string | null
    agentName?: string | null
    promptTokens?: number | null
    completionTokens?: number | null
    totalTokens?: number | null
  }
  toolInfo?: {
    name: string
    args: Record<string, any>
    result?: Record<string, any>
    status?: string
    editDiff?: string
    editFilePath?: string
  }
}

export class MessageLogger {
  private db: KanbanDB
  private currentTaskId: string | null
  private currentTaskRunId: string | null
  private currentWorkflowPhase: string | null
  private currentSessionStatus: string | null

  constructor(context: MessageLoggerContext) {
    this.db = context.db
    this.currentTaskId = context.taskId ?? null
    this.currentTaskRunId = context.taskRunId ?? null
    this.currentWorkflowPhase = context.workflowPhase ?? null
    this.currentSessionStatus = context.sessionStatus ?? null
  }

  /**
   * Update the context (task, phase, etc.) for subsequent messages
   */
  setContext(updates: Partial<Omit<MessageLoggerContext, 'db'>>): void {
    if (updates.taskId !== undefined) this.currentTaskId = updates.taskId ?? null
    if (updates.taskRunId !== undefined) this.currentTaskRunId = updates.taskRunId ?? null
    if (updates.workflowPhase !== undefined) this.currentWorkflowPhase = updates.workflowPhase ?? null
    if (updates.sessionStatus !== undefined) this.currentSessionStatus = updates.sessionStatus ?? null
  }

  /**
   * Log a message from the message.updated event
   */
  async logMessageUpdated(event: any): Promise<void> {
    const parsed = this.parseMessageUpdatedEvent(event)
    if (!parsed) return

    await this.storeMessage(parsed, event)
  }

  /**
   * Log a tool execution from the tool.execute.after event
   */
  async logToolExecuteAfter(input: any, output: any): Promise<void> {
    const parsed = this.parseToolExecuteEvent(input, output)
    if (!parsed) return

    await this.storeMessage(parsed, { input, output })
  }

  /**
   * Log a session update from the session.updated event
   */
  async logSessionUpdated(event: any): Promise<void> {
    const sessionId = this.extractSessionId(event)
    if (!sessionId) return

    // Update session status if available
    const newStatus = event?.properties?.status ?? event?.status
    if (newStatus) {
      this.currentSessionStatus = newStatus
    }

    // Log session status change as a system message
    const message: ParsedMessage = {
      sessionId,
      role: "system",
      messageType: "session_start",
      content: {
        event: "session.updated",
        status: newStatus,
        title: event?.properties?.title ?? event?.title,
      },
      metadata: {
        messageId: event?.properties?.id ?? event?.id,
      },
    }

    await this.storeMessage(message, event)
  }

  /**
   * Log session completion from the session.idle event
   */
  async logSessionIdle(event: any): Promise<void> {
    const sessionId = this.extractSessionId(event)
    if (!sessionId) return

    this.currentSessionStatus = "idle"

    const message: ParsedMessage = {
      sessionId,
      role: "system",
      messageType: "session_end",
      content: {
        event: "session.idle",
        reason: event?.properties?.reason ?? event?.reason,
      },
      metadata: {
        messageId: event?.properties?.id ?? event?.id,
      },
    }

    await this.storeMessage(message, event)
  }

  /**
   * Parse message.updated event into structured format
   */
  private parseMessageUpdatedEvent(event: any): ParsedMessage | null {
    const sessionId = this.extractSessionId(event)
    if (!sessionId) return null

    const info = event?.properties ?? event
    const parts = event?.parts ?? info?.parts ?? []
    
    const role = this.inferRole(info?.role, parts)
    const messageType = this.inferMessageType(parts)
    const content = this.extractContent(parts)
    
    // Extract model info from the event
    const modelInfo = this.extractModelInfo(event)
    
    // Extract token usage if available
    const tokenUsage = this.extractTokenUsage(event)

    return {
      sessionId,
      role,
      messageType,
      content,
      metadata: {
        messageId: info?.id,
        modelProvider: modelInfo.provider,
        modelId: modelInfo.model,
        agentName: info?.agent ?? event?.agent,
        ...tokenUsage,
      },
    }
  }

  /**
   * Parse tool.execute.after event
   */
  private parseToolExecuteEvent(input: any, output: any): ParsedMessage | null {
    const sessionId = this.extractSessionId(input, output)
    if (!sessionId) return null

    const toolName = input?.tool ?? output?.tool
    const toolArgs = input?.args ?? output?.args ?? {}
    const toolResult = output?.result ?? output?.output
    const toolStatus = output?.status ?? (output?.error ? "error" : "success")

    // Generate diff for file operations
    let editDiff: string | undefined
    let editFilePath: string | undefined
    
    if (toolName === "file.write" || toolName === "file.edit") {
      editFilePath = toolArgs?.filePath ?? toolArgs?.path
      if (editFilePath && toolArgs?.content) {
        // Try to get original content for diff (if available in output)
        const originalContent = output?.originalContent ?? toolResult?.originalContent
        if (originalContent !== undefined) {
          editDiff = this.generateDiff(editFilePath, originalContent, toolArgs.content)
        }
      }
    }

    return {
      sessionId,
      role: "tool",
      messageType: "tool_result",
      content: {
        tool: toolName,
        args: toolArgs,
        result: toolResult,
        status: toolStatus,
      },
      metadata: {
        messageId: output?.id,
      },
      toolInfo: {
        name: toolName,
        args: toolArgs,
        result: toolResult,
        status: toolStatus,
        editDiff,
        editFilePath,
      },
    }
  }

  /**
   * Store a parsed message in the database
   */
  private async storeMessage(parsed: ParsedMessage, rawEvent: any): Promise<void> {
    const input: CreateSessionMessageInput = {
      messageId: parsed.metadata.messageId,
      sessionId: parsed.sessionId,
      taskId: this.currentTaskId,
      taskRunId: this.currentTaskRunId,
      timestamp: Date.now(),
      role: parsed.role,
      messageType: parsed.messageType,
      contentJson: parsed.content,
      modelProvider: parsed.metadata.modelProvider,
      modelId: parsed.metadata.modelId,
      agentName: parsed.metadata.agentName,
      promptTokens: parsed.metadata.promptTokens,
      completionTokens: parsed.metadata.completionTokens,
      totalTokens: parsed.metadata.totalTokens,
      toolName: parsed.toolInfo?.name,
      toolArgsJson: parsed.toolInfo?.args,
      toolResultJson: parsed.toolInfo?.result,
      toolStatus: parsed.toolInfo?.status,
      editDiff: parsed.toolInfo?.editDiff,
      editFilePath: parsed.toolInfo?.editFilePath,
      sessionStatus: this.currentSessionStatus,
      workflowPhase: this.currentWorkflowPhase,
      rawEventJson: this.sanitizeRawEvent(rawEvent),
    }

    try {
      this.db.createSessionMessage(input)
    } catch (err) {
      // Log error but don't crash the workflow
      console.error("[message-logger] Failed to store message:", err instanceof Error ? err.message : String(err))
    }
  }

  /**
   * Extract session ID from various event formats
   */
  private extractSessionId(...sources: any[]): string | null {
    for (const source of sources) {
      const candidates = [
        source?.sessionId,
        source?.sessionID,
        source?.properties?.sessionId,
        source?.properties?.sessionID,
        source?.path?.id,
        source?.body?.sessionId,
      ]
      const found = candidates.find(c => typeof c === "string" && c.trim().length > 0)
      if (found) return found
    }
    return null
  }

  /**
   * Infer message role from event data
   */
  private inferRole(roleHint: string | undefined, parts: any[]): MessageRole {
    if (roleHint) {
      const normalized = roleHint.toLowerCase()
      if (normalized === "user") return "user"
      if (normalized === "assistant") return "assistant"
      if (normalized === "system") return "system"
      if (normalized === "tool") return "tool"
    }

    // Infer from parts
    if (parts.some(p => p?.type === "tool")) return "tool"
    if (parts.some(p => p?.type === "step-finish")) return "assistant"
    
    return "assistant" // Default
  }

  /**
   * Infer message type from parts
   */
  private inferMessageType(parts: any[]): MessageType {
    if (parts.some(p => p?.type === "tool")) return "tool_call"
    if (parts.some(p => p?.type === "step-finish")) return "step_finish"
    if (parts.some(p => p?.type === "retry")) return "error"
    if (parts.some(p => p?.state?.status === "error")) return "error"
    return "text"
  }

  /**
   * Extract content from message parts
   */
  private extractContent(parts: any[]): Record<string, any> {
    const content: Record<string, any> = {}
    
    for (const part of parts) {
      if (!part) continue
      
      switch (part.type) {
        case "text":
          content.text = content.text ?? []
          content.text.push(part.text)
          break
        case "tool":
          content.tools = content.tools ?? []
          content.tools.push({
            tool: part.tool,
            args: part.args,
            state: part.state,
          })
          break
        case "step-finish":
          content.stepFinish = {
            reason: part.reason,
          }
          break
        case "retry":
          content.retry = {
            attempt: part.attempt,
            error: part.error,
          }
          break
        default:
          // Store unknown parts as-is
          content.other = content.other ?? []
          content.other.push(part)
      }
    }

    // Convert text array to single string if only one text part
    if (Array.isArray(content.text) && content.text.length === 1) {
      content.text = content.text[0]
    }

    return content
  }

  /**
   * Extract model information from event
   */
  private extractModelInfo(event: any): { provider: string | null; model: string | null } {
    const model = event?.properties?.model ?? event?.model
    
    if (typeof model === "string") {
      // Parse "provider/model" format
      const separatorIndex = model.indexOf("/")
      if (separatorIndex > 0 && separatorIndex < model.length - 1) {
        return {
          provider: model.slice(0, separatorIndex),
          model: model.slice(separatorIndex + 1),
        }
      }
      return { provider: null, model }
    }

    if (model && typeof model === "object") {
      return {
        provider: model.providerID ?? model.provider ?? null,
        model: model.modelID ?? model.id ?? null,
      }
    }

    return { provider: null, model: null }
  }

  /**
   * Extract token usage from event
   */
  private extractTokenUsage(event: any): { 
    promptTokens?: number | null
    completionTokens?: number | null
    totalTokens?: number | null
  } {
    const usage = event?.properties?.usage ?? event?.usage
    
    if (usage && typeof usage === "object") {
      return {
        promptTokens: usage.promptTokens ?? usage.prompt_tokens ?? null,
        completionTokens: usage.completionTokens ?? usage.completion_tokens ?? null,
        totalTokens: usage.totalTokens ?? usage.total_tokens ?? null,
      }
    }

    return {}
  }

  /**
   * Generate a unified diff for file edits
   */
  private generateDiff(filePath: string, originalContent: string, newContent: string): string {
    const lines1 = originalContent.split("\n")
    const lines2 = newContent.split("\n")
    
    // Simple line-by-line diff
    const diffLines: string[] = [`--- a/${filePath}`, `+++ b/${filePath}`]
    
    let i = 0
    let j = 0
    
    while (i < lines1.length || j < lines2.length) {
      if (i < lines1.length && j < lines2.length && lines1[i] === lines2[j]) {
        // Unchanged line
        diffLines.push(" " + lines1[i])
        i++
        j++
      } else if (i < lines1.length && (j >= lines2.length || lines1[i] !== lines2[j])) {
        // Removed line
        diffLines.push("-" + lines1[i])
        i++
      } else if (j < lines2.length) {
        // Added line
        diffLines.push("+" + lines2[j])
        j++
      }
    }
    
    return diffLines.join("\n")
  }

  /**
   * Sanitize raw event for storage (remove circular references, truncate large fields)
   */
  private sanitizeRawEvent(event: any): Record<string, any> {
    try {
      // Convert to JSON and back to remove circular references
      const sanitized = JSON.parse(JSON.stringify(event, (key, value) => {
        // Truncate large strings
        if (typeof value === "string" && value.length > 10000) {
          return value.slice(0, 10000) + "... [truncated]"
        }
        return value
      }))
      return sanitized
    } catch {
      // If serialization fails, return a minimal representation
      return { error: "Failed to serialize event" }
    }
  }
}

/**
 * Create a message logger instance
 */
export function createMessageLogger(context: MessageLoggerContext): MessageLogger {
  return new MessageLogger(context)
}