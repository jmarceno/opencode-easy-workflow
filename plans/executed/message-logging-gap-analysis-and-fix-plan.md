# Message Logging Gap Analysis and Implementation Plan

## Issue Summary

Commit ccb0063ae2bc706a1070bf5bb0ff7d709959eb2d was supposed to introduce full logging of all messages in a session, but important columns are not being filled. Currently only tool calls, results, and session end events are being logged. This is insufficient for recreating full sessions or analyzing errors.

## Current State (The Problem)

From database analysis after task runs:
- **150 tool results** (`tool` role) - tool execution results only
- **11 session_end events** (`system` role) - session completion only  
- **0 user messages** - NOT being logged
- **0 assistant messages** - NOT being logged
- **0 thinking content** - NOT being logged
- **0 agent responses** - NOT being logged

Total: 161 messages across 6 sessions (~25 messages/session)

### Root Cause

The current implementation only captures:
1. `tool.execute.after` - Tool execution results
2. `session.idle` - Session completion
3. `message.updated` - Message metadata updates (but misses initial content!)

**The critical missing hook is `message.part.added`** - this is where OpenCode sends:
- User prompt text
- Assistant thinking/reasoning content
- Text responses
- Tool call requests
- Step progress updates

## Available Hooks Not Being Used

Per OpenCode plugin documentation, these hooks are available but not utilized:

| Hook | Purpose | Currently Used? |
|------|---------|-----------------|
| `message.part.added` | New message parts (thinking, text, tools) | ❌ **MISSING** |
| `message.part.updated` | Streaming updates to parts | ❌ **MISSING** |
| `message.part.removed` | Part removal events | ❌ **MISSING** |
| `message.removed` | Message deletion | ❌ **MISSING** |
| `session.created` | Session start | ❌ **MISSING** |
| `session.error` | Error events | ❌ **MISSING** |
| `session.status` | Status changes | ❌ **MISSING** |
| `permission.asked` | Permission requests | ❌ Not logged |
| `permission.replied` | Permission responses | ❌ **MISSING** |
| `tool.execute.before` | Pre-tool execution | ❌ **MISSING** |

## Implementation Tasks

### 1. Add message.part.added Hook
**Priority: HIGH**

Add the `message.part.added` hook to both bridge and server to capture:
- User prompts
- Assistant thinking/reasoning
- Text responses
- Tool call requests

**Files to modify:**
- `easy-workflow-bridge.ts` - Add hook handler
- `src/server.ts` - Add event handler

### 2. Add message.part.updated Hook  
**Priority: HIGH**

Add the `message.part.updated` hook for streaming content updates. This captures incremental changes to message parts.

**Files to modify:**
- `easy-workflow-bridge.ts` - Add hook handler
- `src/server.ts` - Add event handler

### 3. Add session.created Hook
**Priority: HIGH**

Add the `session.created` hook to properly log session start with initial parameters (model, agent, directory, etc.).

**Files to modify:**
- `easy-workflow-bridge.ts` - Add hook handler
- `src/server.ts` - Add event handler
- `src/message-logger.ts` - Add `logSessionCreated()` method

### 4. Log Permission Interactions
**Priority: MEDIUM**

Add handlers for `permission.asked` and `permission.replied` to log when the system requests and receives permissions.

**Files to modify:**
- `easy-workflow-bridge.ts` - Add hook handlers
- `src/server.ts` - Add event handlers
- `src/message-logger.ts` - Add `logPermissionEvent()` method

### 5. Add session.error Hook
**Priority: MEDIUM**

Add the `session.error` hook to capture error events with full error details.

**Files to modify:**
- `easy-workflow-bridge.ts` - Add hook handler
- `src/server.ts` - Add event handler

### 6. Extend MessageLogger for Part-Based Events
**Priority: HIGH**

Extend the `MessageLogger` class with new parsing methods:

```typescript
// New methods needed:
async logMessagePartAdded(event: any): Promise<void>
async logMessagePartUpdated(event: any): Promise<void>
async logSessionCreated(event: any): Promise<void>
async logSessionError(event: any): Promise<void>
async logPermissionEvent(event: any, type: 'asked' | 'replied'): Promise<void>

// Enhance content extraction for:
// - "thinking" part types (reasoning content)
// - "text" part types (user prompts and responses)
// - "tool" part types (tool call requests)
// - "step" part types (progress updates)
```

**Files to modify:**
- `src/message-logger.ts`

### 7. Add New Message Types
**Priority: HIGH**

Extend the `MessageType` enum in types.ts:

```typescript
export type MessageType = 
  | "text" 
  | "tool_call" 
  | "tool_result" 
  | "error" 
  | "step_finish"
  | "session_start"
  | "session_end"
  | "thinking"           // NEW: Assistant thinking/reasoning
  | "user_prompt"        // NEW: User input messages
  | "assistant_response" // NEW: Assistant text responses
  | "permission_asked"   // NEW: Permission requests
  | "permission_replied" // NEW: Permission responses
  | "session_error"      // NEW: Error events
```

**Files to modify:**
- `src/types.ts`

### 8. Extract Thinking Content from Message Parts
**Priority: HIGH**

Update message parsing logic to properly extract:
- Thinking/reasoning blocks from message parts
- User prompt text
- Assistant responses
- Tool call requests (currently only results are captured)

The message part structure from OpenCode typically includes:
```typescript
{
  type: "thinking" | "text" | "tool" | "step",
  content?: string,
  reasoning?: string,
  tool?: string,
  args?: any,
  // ... other fields
}
```

**Files to modify:**
- `src/message-logger.ts` - Update `extractContent()` and parsing methods

### 9. Add Message Deduplication Logic
**Priority: MEDIUM**

Since we'll receive events from multiple hooks for the same content, implement deduplication:

```typescript
// Track recently logged message IDs with TTL
private recentMessageIds: Map<string, number>
private readonly DEDUP_WINDOW_MS = 1000

private isDuplicate(messageId: string): boolean {
  // Check if we've seen this message recently
}
```

**Files to modify:**
- `src/message-logger.ts`

### 10. Write Comprehensive Tests
**Priority: MEDIUM**

Add tests for new message logging scenarios:
- User prompt logging
- Assistant thinking content logging
- Message part streaming
- Permission events
- Session lifecycle events
- Deduplication logic

**Files to modify:**
- `tests/message-logging.test.ts`

### 11. Update Documentation
**Priority: LOW**

Update `SESSION_LOGGING.md` with:
- New event types
- Updated architecture diagram
- New API endpoints if any
- Examples of complete session timelines

**Files to modify:**
- `SESSION_LOGGING.md`

## Expected Outcome After Fix

Running database queries after implementation should show:

| Role | Message Type | Expected Count |
|------|--------------|----------------|
| `user` | `user_prompt` | ~50+ per session |
| `assistant` | `thinking` | ~20+ per session |
| `assistant` | `assistant_response` | ~10+ per session |
| `assistant` | `tool_call` | ~15+ per session |
| `tool` | `tool_result` | ~15+ per session (existing) |
| `system` | `session_start` | 1 per session |
| `system` | `session_end` | 1 per session (existing) |
| `system` | `permission_asked` | 0-5 per session |
| `system` | `session_error` | 0-2 per session |

**Total: 100+ messages per session** (vs. current ~25)

## Files to Modify Summary

1. **`easy-workflow-bridge.ts`** - Add 5+ new hook handlers
2. **`src/message-logger.ts`** - Add 5+ new parsing methods, deduplication logic, content extraction
3. **`src/types.ts`** - Extend MessageType enum with 4+ new types
4. **`src/server.ts`** - Add 5+ event handler methods and routing
5. **`tests/message-logging.test.ts`** - Add tests for new event types
6. **`SESSION_LOGGING.md`** - Update documentation

## Verification Steps

After implementation, verify by:

1. Run a workflow task
2. Query the database: `SELECT role, message_type, COUNT(*) FROM session_messages GROUP BY role, message_type`
3. Verify user prompts and assistant messages are present
4. Check that thinking content is captured
5. Verify session lifecycle events (created, start, end)
6. Test timeline reconstruction using API endpoints

## References

- OpenCode Plugin Hooks: `ref-docs/opencode.ai-plugins.md`
- Current Implementation: `SESSION_LOGGING.md`
- Database Schema: `src/db.ts` (lines 446-480)
- Message Logger: `src/message-logger.ts`
