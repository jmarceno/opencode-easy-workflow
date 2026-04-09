// Pi RPC Protocol Types
// Based on pi mono packages/coding-agent/src/modes/rpc/rpc-types.ts

export interface PiRpcRequest {
  id: string
  type: string
  [key: string]: unknown
}

export interface PiRpcResponse {
  id?: string
  type: "response"
  command: string
  success: boolean
  data?: Record<string, unknown>
  error?: string
}

export interface PiRpcEvent {
  type?: string
  event?: string
  method?: string
  [key: string]: unknown
}

// Extension UI Request types for interactive prompts
export interface ExtensionUISelectRequest {
  type: "extension_ui_request"
  id: string
  method: "select"
  title: string
  options: string[]
  timeout?: number
}

export interface ExtensionUIConfirmRequest {
  type: "extension_ui_request"
  id: string
  method: "confirm"
  title: string
  message: string
  timeout?: number
}

export interface ExtensionUIInputRequest {
  type: "extension_ui_request"
  id: string
  method: "input"
  title: string
  placeholder?: string
  timeout?: number
}

export interface ExtensionUIEditorRequest {
  type: "extension_ui_request"
  id: string
  method: "editor"
  title: string
  prefill?: string
}

export interface ExtensionUINotifyRequest {
  type: "extension_ui_request"
  id: string
  method: "notify"
  message: string
  notifyType?: "info" | "warning" | "error"
}

export type ExtensionUIRequest =
  | ExtensionUISelectRequest
  | ExtensionUIConfirmRequest
  | ExtensionUIInputRequest
  | ExtensionUIEditorRequest
  | ExtensionUINotifyRequest

// Extension UI Response types
export interface ExtensionUISelectResponse {
  type: "extension_ui_response"
  id: string
  value: string
}

export interface ExtensionUIConfirmResponse {
  type: "extension_ui_response"
  id: string
  confirmed: boolean
}

export interface ExtensionUIInputResponse {
  type: "extension_ui_response"
  id: string
  value: string
}

export interface ExtensionUIEditorResponse {
  type: "extension_ui_response"
  id: string
  value: string
}

export interface ExtensionUICancelledResponse {
  type: "extension_ui_response"
  id: string
  cancelled: true
}

export type ExtensionUIResponse =
  | ExtensionUISelectResponse
  | ExtensionUIConfirmResponse
  | ExtensionUIInputResponse
  | ExtensionUIEditorResponse
  | ExtensionUICancelledResponse
