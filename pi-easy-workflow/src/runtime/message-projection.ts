import type { CreateSessionMessageInput, MessageRole, MessageType } from "../types.ts"

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function pickString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) return value
  }
  return null
}

function pickNumber(...values: unknown[]): number | null {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return value
  }
  return null
}

function normalizeTimestamp(value: unknown): number | null {
  const numeric = pickNumber(value)
  if (numeric === null) return null
  if (numeric > 1_000_000_000_000) return Math.floor(numeric / 1000)
  return Math.floor(numeric)
}

function contentToText(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""

  const parts: string[] = []
  for (const item of content) {
    const part = asRecord(item)
    const type = pickString(part.type)
    if (type === "text") {
      const text = pickString(part.text)
      if (text) parts.push(text)
      continue
    }
    if (type === "thinking") {
      const thinking = pickString(part.thinking)
      if (thinking) parts.push(thinking)
      continue
    }
    if (type === "toolCall") {
      const name = pickString(part.name)
      const args = part.arguments && typeof part.arguments === "object"
        ? JSON.stringify(part.arguments)
        : pickString(part.partialJson)
      if (name) {
        parts.push(args ? `${name} ${args}` : name)
      }
      continue
    }
  }

  return parts.join("\n").trim()
}

function resultToText(result: unknown): string {
  const resultRecord = asRecord(result)
  const directText = pickString(resultRecord.text, resultRecord.content)
  if (directText) return directText
  return contentToText(resultRecord.content)
}

function extractMessage(event: Record<string, unknown>): Record<string, unknown> {
  return asRecord(event.message)
}

function extractAssistantEvent(event: Record<string, unknown>): Record<string, unknown> {
  return asRecord(event.assistantMessageEvent)
}

function extractPartial(assistantEvent: Record<string, unknown>): Record<string, unknown> {
  return asRecord(assistantEvent.partial)
}

function extractToolCall(event: Record<string, unknown>, assistantEvent: Record<string, unknown>, partial: Record<string, unknown>): Record<string, unknown> {
  const toolCall = asRecord(assistantEvent.toolCall)
  if (Object.keys(toolCall).length > 0) return toolCall

  for (const item of asArray(partial.content)) {
    const part = asRecord(item)
    if (pickString(part.type) === "toolCall") return part
  }

  const message = extractMessage(event)
  for (const item of asArray(message.content)) {
    const part = asRecord(item)
    if (pickString(part.type) === "toolCall") return part
  }

  return {}
}

function extractUsage(event: Record<string, unknown>, message: Record<string, unknown>, partial: Record<string, unknown>): Record<string, unknown> {
  const eventType = pickString(event.type)
  const role = pickString(message.role, partial.role)

  if (eventType === "message_end" && role === "assistant") {
    return asRecord(message.usage)
  }

  return {}
}

function resolveExactEventName(event: Record<string, unknown>, assistantEvent: Record<string, unknown>): string | null {
  const eventType = pickString(event.type, event.event, event.method)
  const assistantType = pickString(assistantEvent.type)
  if (eventType === "message_update" && assistantType) return `${eventType}:${assistantType}`
  return eventType
}

function resolveRawRole(event: Record<string, unknown>, message: Record<string, unknown>, partial: Record<string, unknown>): string | null {
  const role = pickString(message.role, partial.role, event.role)
  if (role) return role

  const eventType = pickString(event.type) ?? ""
  if (eventType === "message_update") return "assistant"
  if (eventType.startsWith("tool_execution")) return "tool"
  if (eventType === "agent_start" || eventType === "agent_end" || eventType === "turn_start" || eventType === "turn_end") return "system"
  return null
}

function resolveRole(event: Record<string, unknown>, message: Record<string, unknown>, partial: Record<string, unknown>): MessageRole {
  const rawRole = resolveRawRole(event, message, partial)
  if (rawRole === "user") return "user"
  if (rawRole === "assistant") return "assistant"
  if (rawRole === "system") return "system"
  if (rawRole === "tool" || rawRole === "toolResult" || rawRole === "bashExecution") return "tool"

  const eventType = pickString(event.type) ?? ""
  if (eventType.startsWith("tool_execution")) return "tool"
  return "system"
}

function resolveType(event: Record<string, unknown>, message: Record<string, unknown>, assistantEvent: Record<string, unknown>): MessageType {
  const eventType = pickString(event.type) ?? ""
  const assistantType = pickString(assistantEvent.type) ?? ""
  const rawRole = pickString(message.role)

  if (assistantType.startsWith("thinking")) return "thinking"
  if (assistantType.startsWith("toolcall")) return "tool_call"
  if (assistantType.endsWith("_delta") || assistantType.endsWith("_start")) return "message_part"
  if (assistantType.endsWith("_end")) return assistantType.startsWith("text") ? "text" : "message_part"

  if (eventType === "message_start" || eventType === "message_end") {
    if (rawRole === "user") return "user_prompt"
    if (rawRole === "assistant") return "assistant_response"
    if (rawRole === "toolResult" || rawRole === "tool") return "tool_result"
  }

  if (eventType === "tool_execution_start") return "tool_call"
  if (eventType === "tool_execution_end") return "tool_result"
  if (eventType === "extension_ui_request") return "permission_asked"
  if (eventType === "extension_ui_response") return "permission_replied"
  if (eventType === "agent_start" || eventType === "turn_start") return "step_start"
  if (eventType === "agent_end" || eventType === "turn_end") return "step_finish"
  if (eventType.includes("error")) return "session_error"

  return "session_status"
}

function extractText(event: Record<string, unknown>, message: Record<string, unknown>, assistantEvent: Record<string, unknown>, partial: Record<string, unknown>): string {
  const direct = pickString(
    assistantEvent.text,
    assistantEvent.delta,
    assistantEvent.content,
    event.text,
    message.text,
    message.content,
  )
  if (direct) return direct

  const fromPartial = contentToText(partial.content)
  if (fromPartial) return fromPartial

  const fromMessage = contentToText(message.content)
  if (fromMessage) return fromMessage

  const fromResult = resultToText(event.result)
  if (fromResult) return fromResult

  return ""
}

function extractEditMetadata(toolName: string | null, toolArgs: Record<string, unknown> | null): { editDiff: string | null; editFilePath: string | null } {
  if (!toolName) return { editDiff: null, editFilePath: null }

  const path = pickString(toolArgs?.path, toolArgs?.filePath)
  if (toolName === "apply_patch") {
    return {
      editDiff: pickString(toolArgs?.patchText, toolArgs?.patch) ?? null,
      editFilePath: path,
    }
  }

  if (toolName === "write" || toolName === "edit" || toolName === "multi_edit") {
    return {
      editDiff: null,
      editFilePath: path,
    }
  }

  return { editDiff: null, editFilePath: null }
}

function buildContentJson(input: {
  event: Record<string, unknown>
  message: Record<string, unknown>
  assistantEvent: Record<string, unknown>
  partial: Record<string, unknown>
  usage: Record<string, unknown>
  toolCall: Record<string, unknown>
  toolArgs: Record<string, unknown> | null
  toolResult: Record<string, unknown> | null
  text: string
  exactEventName: string | null
  rawRole: string | null
}): Record<string, unknown> {
  return {
    text: input.text,
    eventType: pickString(input.event.type) ?? null,
    eventName: input.exactEventName,
    assistantEventType: pickString(input.assistantEvent.type) ?? null,
    rawRole: input.rawRole,
    content: asArray(input.partial.content).length > 0
      ? input.partial.content
      : asArray(input.message.content).length > 0
        ? input.message.content
        : null,
    delta: pickString(input.assistantEvent.delta) ?? null,
    usage: Object.keys(input.usage).length > 0 ? input.usage : null,
    responseId: pickString(input.partial.responseId, input.message.responseId) ?? null,
    stopReason: pickString(input.partial.stopReason, input.message.stopReason) ?? null,
    toolCall: Object.keys(input.toolCall).length > 0 ? input.toolCall : null,
    toolArgs: input.toolArgs,
    toolResult: input.toolResult,
    isError: typeof input.event.isError === "boolean" ? input.event.isError : null,
  }
}

export function projectPiEventToSessionMessage(input: {
  event: unknown
  sessionId: string
  taskId?: string | null
  taskRunId?: string | null
}): CreateSessionMessageInput {
  const event = asRecord(input.event)
  const message = extractMessage(event)
  const assistantEvent = extractAssistantEvent(event)
  const partial = extractPartial(assistantEvent)
  const toolCall = extractToolCall(event, assistantEvent, partial)
  const toolArgs = Object.keys(toolCall).length > 0
    ? asRecord(toolCall.arguments)
    : Object.keys(asRecord(event.args)).length > 0
      ? asRecord(event.args)
      : null
  const toolResult = Object.keys(asRecord(event.result)).length > 0 ? asRecord(event.result) : null
  const text = extractText(event, message, assistantEvent, partial)
  const usage = extractUsage(event, message, partial)
  const exactEventName = resolveExactEventName(event, assistantEvent)
  const rawRole = resolveRawRole(event, message, partial)
  const toolName = pickString(toolCall.name, event.toolName)
  const toolCallId = pickString(toolCall.id, event.toolCallId)
  const cost = asRecord(usage.cost)
  const { editDiff, editFilePath } = extractEditMetadata(toolName, toolArgs)

  return {
    messageId: pickString(event.messageId, assistantEvent.messageId, partial.responseId, message.responseId, message.id) ?? null,
    sessionId: input.sessionId,
    taskId: input.taskId ?? null,
    taskRunId: input.taskRunId ?? null,
    timestamp: normalizeTimestamp(partial.timestamp ?? message.timestamp ?? event.timestamp) ?? undefined,
    role: resolveRole(event, message, partial),
    eventName: exactEventName,
    messageType: resolveType(event, message, assistantEvent),
    contentJson: buildContentJson({
      event,
      message,
      assistantEvent,
      partial,
      usage,
      toolCall,
      toolArgs,
      toolResult,
      text,
      exactEventName,
      rawRole,
    }),
    modelProvider: pickString(partial.provider, message.provider, event.provider) ?? null,
    modelId: pickString(partial.model, message.model, event.modelId, event.model) ?? null,
    agentName: pickString(event.agentName, partial.agentName, message.agentName) ?? null,
    promptTokens: pickNumber(usage.input),
    completionTokens: pickNumber(usage.output),
    cacheReadTokens: pickNumber(usage.cacheRead),
    cacheWriteTokens: pickNumber(usage.cacheWrite),
    totalTokens: pickNumber(usage.totalTokens),
    costJson: Object.keys(cost).length > 0 ? cost : null,
    costTotal: pickNumber(cost.total),
    toolCallId,
    toolName,
    toolArgsJson: toolArgs,
    toolResultJson: toolResult,
    toolStatus: typeof event.isError === "boolean" ? (event.isError ? "error" : "success") : null,
    editDiff,
    editFilePath,
    sessionStatus: event.type === "agent_start"
      ? "active"
      : event.type === "agent_end"
        ? "completed"
        : null,
    workflowPhase: null,
    rawEventJson: event,
  }
}
