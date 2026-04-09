import { describe, expect, it } from "bun:test"
import { projectPiEventToSessionMessage } from "../src/runtime/message-projection.ts"

describe("projectPiEventToSessionMessage", () => {
  it("captures assistant message payload, usage, and cost from pi message_end events", () => {
    const projected = projectPiEventToSessionMessage({
      sessionId: "session-1",
      event: {
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Implementation complete" }],
          provider: "anthropic",
          model: "claude-sonnet-4-5",
          responseId: "resp-123",
          timestamp: 1_710_000_000_000,
          usage: {
            input: 1200,
            output: 300,
            cacheRead: 45,
            cacheWrite: 12,
            totalTokens: 1557,
            cost: {
              input: 0.12,
              output: 0.34,
              cacheRead: 0.01,
              cacheWrite: 0.02,
              total: 0.49,
            },
          },
        },
      },
    })

    expect(projected.timestamp).toBe(1_710_000_000)
    expect(projected.role).toBe("assistant")
    expect(projected.eventName).toBe("message_end")
    expect(projected.messageType).toBe("assistant_response")
    expect(projected.messageId).toBe("resp-123")
    expect(projected.modelProvider).toBe("anthropic")
    expect(projected.modelId).toBe("claude-sonnet-4-5")
    expect(projected.promptTokens).toBe(1200)
    expect(projected.completionTokens).toBe(300)
    expect(projected.cacheReadTokens).toBe(45)
    expect(projected.cacheWriteTokens).toBe(12)
    expect(projected.totalTokens).toBe(1557)
    expect(projected.costTotal).toBe(0.49)
    expect(projected.contentJson.text).toBe("Implementation complete")
    expect(projected.contentJson.usage).toEqual({
      input: 1200,
      output: 300,
      cacheRead: 45,
      cacheWrite: 12,
      totalTokens: 1557,
      cost: {
        input: 0.12,
        output: 0.34,
        cacheRead: 0.01,
        cacheWrite: 0.02,
        total: 0.49,
      },
    })
  })

  it("captures tool execution metadata from pi tool events", () => {
    const projected = projectPiEventToSessionMessage({
      sessionId: "session-1",
      event: {
        type: "tool_execution_end",
        toolCallId: "call-1",
        toolName: "write",
        args: { path: "/tmp/file.txt", content: "hello" },
        result: { content: [{ type: "text", text: "Successfully wrote file" }] },
        isError: false,
      },
    })

    expect(projected.role).toBe("tool")
    expect(projected.eventName).toBe("tool_execution_end")
    expect(projected.messageType).toBe("tool_result")
    expect(projected.toolCallId).toBe("call-1")
    expect(projected.toolName).toBe("write")
    expect(projected.toolArgsJson).toEqual({ path: "/tmp/file.txt", content: "hello" })
    expect(projected.toolResultJson).toEqual({ content: [{ type: "text", text: "Successfully wrote file" }] })
    expect(projected.toolStatus).toBe("success")
    expect(projected.editFilePath).toBe("/tmp/file.txt")
    expect(projected.contentJson.text).toBe("Successfully wrote file")
  })
})
