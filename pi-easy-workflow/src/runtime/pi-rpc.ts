export interface PiRpcRequest {
  id: number
  method: string
  params?: Record<string, unknown>
}

export interface PiRpcResponse {
  id: number
  result?: Record<string, unknown>
  error?: unknown
}

export interface PiRpcEvent {
  method?: string
  event?: string
  type?: string
  params?: Record<string, unknown>
  payload?: Record<string, unknown>
  [key: string]: unknown
}

export function buildInitializeCommand(params: {
  cwd: string
  model?: string
  thinkingLevel?: string
}): Omit<PiRpcRequest, "id"> {
  return {
    method: "initialize",
    params: {
      cwd: params.cwd,
      ...(params.model ? { model: params.model } : {}),
      ...(params.thinkingLevel && params.thinkingLevel !== "default" ? { thinkingLevel: params.thinkingLevel } : {}),
    },
  }
}

export function buildPromptCommand(promptText: string): Omit<PiRpcRequest, "id"> {
  return {
    method: "prompt",
    params: {
      prompt: promptText,
    },
  }
}

export function buildSnapshotCommand(): Omit<PiRpcRequest, "id"> {
  return {
    method: "get_messages",
    params: {},
  }
}
