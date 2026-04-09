/**
 * Message Logger Service
 * 
 * Processes OpenCode events and extracts message data for storage.
 * Handles message parsing, diff generation for file edits, and
 * prepares data for the session_messages table.
 */

import { createHash } from "crypto"
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
  timestamp?: number
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

interface CachedMessageMetadata {
  role: MessageRole
  metadata: ParsedMessage["metadata"]
}

export class MessageLogger {
  private db: KanbanDB
  private currentTaskId: string | null
  private currentTaskRunId: string | null
  private currentWorkflowPhase: string | null
  private currentSessionStatus: string | null
  private recentEventKeys: Map<string, number>
  private messageMetadata: Map<string, CachedMessageMetadata>
  private readonly DEDUP_WINDOW_MS = 5000

  constructor(context: MessageLoggerContext) {
    this.db = context.db
    this.currentTaskId = context.taskId ?? null
    this.currentTaskRunId = context.taskRunId ?? null
    this.currentWorkflowPhase = context.workflowPhase ?? null
    this.currentSessionStatus = context.sessionStatus ?? null
    this.recentEventKeys = new Map()
    this.messageMetadata = new Map()
  }

  private isDuplicateEvent(prefix: string, payload: any): boolean {
    const fingerprint = this.fingerprint(payload)
    const key = `${prefix}:${fingerprint}`
    const now = Date.now()
    const existing = this.recentEventKeys.get(key)
    if (existing && now - existing < this.DEDUP_WINDOW_MS) {
      return true
    }
    this.recentEventKeys.set(key, now)
    for (const [key, timestamp] of this.recentEventKeys.entries()) {
      if (now - timestamp > this.DEDUP_WINDOW_MS * 2) {
        this.recentEventKeys.delete(key)
      }
    }
    return false
  }

  private fingerprint(payload: any): string {
    try {
      return createHash("sha1").update(JSON.stringify(this.sanitizeRawEvent(payload))).digest("hex")
    } catch {
      return createHash("sha1").update(String(payload ?? "")).digest("hex")
    }
  }

  private unwrapEvent(event: any): any {
    return event?.event ?? event
  }

  private eventProperties(event: any): any {
    const raw = this.unwrapEvent(event)
    return raw?.properties ?? raw
  }

  private rememberMessageMetadata(messageId: string | null | undefined, value: CachedMessageMetadata): void {
    if (!messageId) return
    this.messageMetadata.set(messageId, value)
  }

  private getMessageMetadata(messageId: string | null | undefined): CachedMessageMetadata | undefined {
    if (!messageId) return undefined
    return this.messageMetadata.get(messageId)
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
    if (this.isDuplicateEvent("message.updated", event)) return

    const parsed = this.parseMessageUpdatedEvent(event)
    if (!parsed) return

    await this.storeMessage(parsed, event)
  }

  /**
   * Log a tool execution from the tool.execute.after event
   */
  async logToolExecuteAfter(input: any, output: any): Promise<void> {
    if (this.isDuplicateEvent("tool.execute.after", { input, output })) return

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

    if (this.isDuplicateEvent("session.updated", event)) return

    const properties = this.eventProperties(event)
    const info = properties?.info ?? properties

    // Update session status if available
    const newStatus = properties?.status ?? info?.status
    if (newStatus) {
      this.currentSessionStatus = typeof newStatus === "string" ? newStatus : newStatus?.type ?? this.currentSessionStatus
    }

    const message: ParsedMessage = {
      sessionId,
      timestamp: info?.time?.updated,
      role: "system",
      messageType: "session_status",
      content: {
        event: "session.updated",
        status: newStatus,
        info,
      },
      metadata: {
        messageId: info?.id,
      },
    }

    await this.storeMessage(message, event)
  }

  async logSessionStatus(event: any): Promise<void> {
    const sessionId = this.extractSessionId(event)
    if (!sessionId) return

    if (this.isDuplicateEvent("session.status", event)) return

    const properties = this.eventProperties(event)
    const status = properties?.status ?? event?.status
    if (status?.type) {
      this.currentSessionStatus = status.type
    }

    await this.storeMessage(
      {
        sessionId,
        role: "system",
        messageType: "session_status",
        content: {
          event: "session.status",
          status,
        },
        metadata: {},
      },
      event,
    )
  }

  /**
   * Log session completion from the session.idle event
   */
  async logSessionIdle(event: any): Promise<void> {
    const sessionId = this.extractSessionId(event)
    if (!sessionId) return

    if (this.isDuplicateEvent("session.idle", event)) return

    this.currentSessionStatus = "idle"

    const properties = this.eventProperties(event)

    const message: ParsedMessage = {
      sessionId,
      role: "system",
      messageType: "session_end",
      content: {
        event: "session.idle",
        reason: properties?.reason ?? event?.reason,
      },
      metadata: {},
    }

    await this.storeMessage(message, event)
  }

  async logMessagePartAdded(input: any, output: any, sessionIdHint?: string): Promise<void> {
    const event = this.unwrapEvent(input)
    const sessionId = sessionIdHint || this.extractSessionId(event, output)
    if (!sessionId) return

    const properties = this.eventProperties(event)
    const part = properties?.part ?? output?.part ?? input?.part
    if (!part) return

    if (this.isDuplicateEvent("message.part.added", event)) return

    const parsed = this.parseMessagePart(part, sessionId, part?.messageID ?? null, properties?.time)
    if (!parsed) return

    await this.storeMessage(parsed, event)
  }

  async logMessagePartUpdated(input: any, output: any, sessionIdHint?: string): Promise<void> {
    const event = this.unwrapEvent(input)
    const sessionId = sessionIdHint || this.extractSessionId(event, output)
    if (!sessionId) return

    const properties = this.eventProperties(event)
    const part = properties?.part ?? output?.part ?? input?.part
    if (!part) return

    if (this.isDuplicateEvent("message.part.updated", event)) return

    const parsed = this.parseMessagePartUpdate(part, sessionId, part?.messageID ?? null, properties?.time)
    if (!parsed) return

    await this.storeMessage(parsed, event)
  }

  async logSessionCreated(event: any): Promise<void> {
    const sessionId = this.extractSessionId(event)
    if (!sessionId) return

    if (this.isDuplicateEvent("session.created", event)) return

    const properties = this.eventProperties(event)
    const info = properties?.info ?? properties

    this.currentSessionStatus = "created"

    const message: ParsedMessage = {
      sessionId,
      timestamp: info?.time?.created,
      role: "system",
      messageType: "session_start",
      content: {
        event: "session.created",
        info,
      },
      metadata: {
        messageId: info?.id,
        modelProvider: this.extractModelInfo(event).provider,
        modelId: this.extractModelInfo(event).model,
        agentName: info?.agent ?? null,
      },
    }

    await this.storeMessage(message, event)
  }

  async logSessionError(event: any): Promise<void> {
    const sessionId = this.extractSessionId(event)
    if (!sessionId) return

    if (this.isDuplicateEvent("session.error", event)) return

    const properties = this.eventProperties(event)

    this.currentSessionStatus = "error"

    const message: ParsedMessage = {
      sessionId,
      role: "system",
      messageType: "session_error",
      content: {
        event: "session.error",
        error: properties?.error ?? event?.error,
        reason: properties?.reason ?? event?.reason,
      },
      metadata: {},
    }

    await this.storeMessage(message, event)
  }

  async logPermissionEvent(event: any, type: 'asked' | 'replied'): Promise<void> {
    const sessionId = this.extractSessionId(event)
    if (!sessionId) return

    if (this.isDuplicateEvent(`permission.${type}`, event)) return

    const properties = this.eventProperties(event)
    const permissionId = properties?.id ?? properties?.permissionID ?? event?.id ?? event?.requestID
    const messageId = `permission_${type}_${permissionId}`

    const messageType = type === 'asked' ? 'permission_asked' : 'permission_replied'
    
    const content: Record<string, any> = {
      event: `permission.${type}`,
      permissionId,
    }

    if (type === 'asked') {
      content.message = properties?.message ?? event?.message
      content.tool = properties?.tool ?? event?.tool
      content.args = properties?.args ?? event?.args
    } else {
      content.response = properties?.response ?? event?.response
    }

    const message: ParsedMessage = {
      sessionId,
      role: "system",
      messageType,
      content,
      metadata: {
        messageId,
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

    const raw = this.unwrapEvent(event)
    const properties = this.eventProperties(event)
    const info = properties?.info ?? properties
    const parts = raw?.parts ?? properties?.parts ?? []
    if (!info?.role && parts.length === 0) return null
    
    const role = this.inferRole(info?.role, parts)
    const messageType = parts.length > 0 ? this.inferMessageType(parts) : this.inferMessageTypeFromInfo(info)
    const content = parts.length > 0 ? this.extractContent(parts) : { info }
    
    // Extract model info from the event
    const modelInfo = this.extractModelInfo(info)
    
    // Extract token usage if available
    const tokenUsage = this.extractTokenUsage(info)

    const parsed: ParsedMessage = {
      sessionId,
      timestamp: info?.time?.completed ?? info?.time?.updated ?? info?.time?.created,
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

    this.rememberMessageMetadata(info?.id, {
      role,
      metadata: parsed.metadata,
    })

    return parsed
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
        callId: input?.callID,
        args: toolArgs,
        result: toolResult,
        status: toolStatus,
      },
      metadata: {
        messageId: input?.callID ?? output?.id,
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

  private parseMessagePart(
    part: any,
    sessionId: string,
    messageId: string | null,
    timestamp?: number,
  ): ParsedMessage | null {
    if (!part || !part.type) return null

    const cached = this.getMessageMetadata(messageId ?? part?.messageID)
    const role = this.inferRoleFromPart(part, cached?.role)
    const { messageType, content, toolInfo } = this.extractPartContent(part, cached?.role ?? role)

    return {
      sessionId,
      timestamp: timestamp ?? part?.time?.end ?? part?.time?.start,
      role,
      messageType,
      content,
      metadata: {
        messageId: messageId ?? part?.messageID ?? cached?.metadata.messageId ?? null,
        modelProvider: cached?.metadata.modelProvider,
        modelId: cached?.metadata.modelId,
        agentName: part?.agent ?? cached?.metadata.agentName,
        promptTokens: cached?.metadata.promptTokens,
        completionTokens: cached?.metadata.completionTokens,
        totalTokens: cached?.metadata.totalTokens,
      },
      toolInfo,
    }
  }

  private parseMessagePartUpdate(
    part: any,
    sessionId: string,
    messageId: string | null,
    timestamp?: number,
  ): ParsedMessage | null {
    return this.parseMessagePart(part, sessionId, messageId, timestamp)
  }

  private inferRoleFromPart(part: any, messageRole?: MessageRole): MessageRole {
    if (messageRole) return messageRole

    const partType = part?.type
    if (partType === 'tool' || partType === 'tool_call') return 'assistant'
    if (partType === 'user' || partType === 'user_prompt') return 'user'
    if (partType === 'system') return 'system'
    if (part?.role) {
      const normalized = part.role.toLowerCase()
      if (normalized === 'user') return 'user'
      if (normalized === 'assistant') return 'assistant'
      if (normalized === 'system') return 'system'
      if (normalized === 'tool') return 'tool'
    }
    if (partType === 'thinking' || partType === 'reasoning') return 'assistant'
    return 'assistant'
  }

  private extractPartContent(
    part: any,
    messageRole: MessageRole,
  ): {
    messageType: MessageType
    content: Record<string, any>
    toolInfo?: ParsedMessage["toolInfo"]
  } {
    const content: Record<string, any> = {}
    const partType = part?.type ?? part?.partType

    switch (partType) {
      case 'text':
        content.text = part?.text ?? part?.content ?? ''
        if (part?.metadata) content.metadata = part.metadata
        if (part?.time) content.time = part.time
        if (part?.synthetic !== undefined) content.synthetic = part.synthetic
        if (part?.ignored !== undefined) content.ignored = part.ignored
        return { messageType: messageRole === 'user' ? 'user_prompt' : 'assistant_response', content }
      
      case 'thinking':
      case 'reasoning':
        content.text = part?.text ?? part?.thinking ?? part?.content ?? part?.reasoning ?? ''
        content.reasoning = content.text
        if (part?.metadata) content.metadata = part.metadata
        if (part?.time) content.time = part.time
        return { messageType: 'thinking', content }
      
      case 'tool':
      case 'tool_call':
      case 'tool_request': {
        const state = part?.state ?? {}
        const args = state?.input ?? part?.args ?? {}
        content.tool = part?.tool
        content.callId = part?.callID
        content.args = args
        content.state = state

        if (state?.status === 'completed') {
          content.output = state.output
          if (state?.metadata) content.metadata = state.metadata
          if (state?.attachments) content.attachments = state.attachments
          return {
            messageType: 'tool_result',
            content,
            toolInfo: {
              name: part?.tool,
              args,
              result: {
                output: state.output,
                metadata: state.metadata,
                attachments: state.attachments,
              },
              status: state.status,
            },
          }
        }

        if (state?.status === 'error') {
          content.error = state.error
          if (state?.metadata) content.metadata = state.metadata
          return {
            messageType: 'tool_result',
            content,
            toolInfo: {
              name: part?.tool,
              args,
              result: {
                error: state.error,
                metadata: state.metadata,
              },
              status: state.status,
            },
          }
        }

        return {
          messageType: partType === 'tool_request' ? 'tool_request' : 'tool_call',
          content,
          toolInfo: {
            name: part?.tool,
            args,
            status: state?.status ?? 'pending',
          },
        }
      }

      case 'step-start':
        content.snapshot = part?.snapshot
        return { messageType: 'step_start', content }

      case 'step':
      case 'step_progress':
      case 'step-finish':
        content.reason = part?.reason
        content.step = part?.step ?? part?.content
        content.progress = part?.progress
        content.snapshot = part?.snapshot
        content.cost = part?.cost
        content.tokens = part?.tokens
        return { messageType: 'step_finish', content }
      
      case 'retry':
        content.attempt = part?.attempt
        content.error = part?.error
        content.time = part?.time
        return { messageType: 'error', content }
      
      case 'error':
        content.error = part?.error ?? part?.message
        return { messageType: 'error', content }
      
      default:
        content.raw = part
        return { messageType: 'message_part', content }
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
      timestamp: parsed.timestamp ?? Date.now(),
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
        source?.info?.sessionID,
        source?.part?.sessionID,
        source?.properties?.sessionId,
        source?.properties?.sessionID,
        source?.properties?.info?.sessionID,
        source?.properties?.part?.sessionID,
        source?.event?.properties?.sessionID,
        source?.event?.properties?.info?.sessionID,
        source?.event?.properties?.part?.sessionID,
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
    if (parts.some(p => p?.type === "step-start")) return "step_start"
    if (parts.some(p => p?.type === "step-finish")) return "step_finish"
    if (parts.some(p => p?.type === "retry")) return "error"
    if (parts.some(p => p?.type === "thinking" || p?.type === "reasoning")) return "thinking"
    if (parts.some(p => p?.type === "user" || p?.type === "user_prompt")) return "user_prompt"
    if (parts.some(p => p?.type === "assistant" || p?.type === "assistant_response")) return "assistant_response"
    if (parts.some(p => p?.state?.status === "error")) return "error"
    return "text"
  }

  private inferMessageTypeFromInfo(info: any): MessageType {
    if (info?.error) return "error"
    if (info?.role === "user") return "user_prompt"
    if (info?.role === "assistant") return "assistant_response"
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
            args: part.state?.input ?? part.args,
            state: part.state,
          })
          break
        case "step-start":
          content.stepStart = {
            snapshot: part.snapshot,
          }
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
        case "thinking":
        case "reasoning":
          content.thinking = content.thinking ?? []
          content.thinking.push(part.thinking ?? part.content ?? part.reasoning ?? '')
          content.reasoning = content.reasoning ?? []
          content.reasoning.push(part.reasoning ?? part.thinking ?? '')
          break
        case "user":
        case "user_prompt":
          content.text = content.text ?? []
          content.text.push(part.text ?? part.content ?? '')
          content.isUserPrompt = true
          break
        case "assistant":
        case "assistant_response":
          content.text = content.text ?? []
          content.text.push(part.text ?? part.content ?? '')
          content.isAssistantResponse = true
          break
        default:
          content.other = content.other ?? []
          content.other.push(part)
      }
    }

    if (Array.isArray(content.text) && content.text.length === 1) {
      content.text = content.text[0]
    }
    if (Array.isArray(content.thinking) && content.thinking.length === 1) {
      content.thinking = content.thinking[0]
    }
    if (Array.isArray(content.reasoning) && content.reasoning.length === 1) {
      content.reasoning = content.reasoning[0]
    }

    return content
  }

  /**
   * Extract model information from event
   */
  private extractModelInfo(event: any): { provider: string | null; model: string | null } {
    const properties = this.eventProperties(event)
    const info = properties?.info ?? properties
    const model = properties?.model ?? info?.model ?? event?.model

    if (info?.providerID || info?.modelID) {
      return {
        provider: info?.providerID ?? null,
        model: info?.modelID ?? null,
      }
    }
    
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
    const properties = this.eventProperties(event)
    const info = properties?.info ?? properties
    const usage = properties?.usage ?? info?.usage ?? info?.tokens ?? event?.usage ?? event?.tokens
    
    if (usage && typeof usage === "object") {
      const promptTokens = usage.promptTokens ?? usage.prompt_tokens ?? usage.input ?? usage.inputTokens ?? null
      const completionTokens = usage.completionTokens ?? usage.completion_tokens ?? usage.output ?? usage.outputTokens ?? null
      const totalTokens =
        usage.totalTokens ??
        usage.total_tokens ??
        usage.total ??
        (typeof promptTokens === "number" && typeof completionTokens === "number"
          ? promptTokens + completionTokens + (usage.reasoning ?? usage.reasoningTokens ?? 0)
          : null)

      return {
        promptTokens,
        completionTokens,
        totalTokens,
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
