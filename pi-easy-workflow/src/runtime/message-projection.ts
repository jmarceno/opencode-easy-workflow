import type { CreateSessionMessageInput, MessageRole, MessageType } from "../types.ts"

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function pullText(value: unknown): string {
  if (typeof value === "string") return value
  if (!value || typeof value !== "object") return ""
  const objectValue = value as Record<string, unknown>
  if (typeof objectValue.text === "string") return objectValue.text
  if (typeof objectValue.content === "string") return objectValue.content
  return ""
}

function resolveRole(event: Record<string, unknown>): MessageRole {
  const role = event.role
  if (role === "assistant" || role === "user" || role === "system" || role === "tool") return role
  const method = String(event.method ?? event.event ?? event.type ?? "").toLowerCase()
  if (method.includes("tool")) return "tool"
  return "assistant"
}

function resolveType(event: Record<string, unknown>): MessageType {
  const method = String(event.method ?? event.event ?? event.type ?? "").toLowerCase()
  if (method.includes("tool_call")) return "tool_call"
  if (method.includes("tool_result")) return "tool_result"
  if (method.includes("thinking")) return "thinking"
  if (method.includes("error")) return "session_error"
  if (method.includes("start")) return "step_start"
  if (method.includes("finish") || method.includes("complete")) return "step_finish"
  return "text"
}

export function projectPiEventToSessionMessage(input: {
  event: unknown
  sessionId: string
  taskId?: string | null
  taskRunId?: string | null
}): CreateSessionMessageInput {
  const event = asRecord(input.event)
  const params = asRecord(event.params)
  const payload = asRecord(event.payload)
  const text = pullText(payload.text ?? params.text ?? event.text ?? payload.content ?? params.content)

  return {
    messageId: typeof event.id === "string" ? event.id : null,
    sessionId: input.sessionId,
    taskId: input.taskId ?? null,
    taskRunId: input.taskRunId ?? null,
    role: resolveRole({ ...event, ...params, ...payload }),
    messageType: resolveType({ ...event, ...params, ...payload }),
    contentJson: {
      text,
      method: event.method ?? event.event ?? event.type ?? null,
      params,
      payload,
    },
    rawEventJson: event,
  }
}
