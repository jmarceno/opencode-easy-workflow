# Session Message Logging Implementation

## Overview
This implementation adds comprehensive message logging to the Easy Workflow system, capturing every IA (Intelligent Assistant) message into the database for timeline reconstruction and analysis.

## Architecture

### Components Implemented

1. **Database Schema** (`src/db.ts`)
   - New `session_messages` table with comprehensive fields
   - Indexes for efficient querying by session, task, timestamp, and role
   - Foreign key constraints linking to existing workflow tables
   - Migration support for backward compatibility

2. **Type Definitions** (`src/types.ts`)
   - `SessionMessage` interface with all metadata fields
   - `CreateSessionMessageInput` for message creation
   - `TimelineEntry` for formatted timeline responses
   - Type-safe enums for `MessageRole` and `MessageType`

3. **Message Logger Service** (`src/message-logger.ts`)
   - Event parser for OpenCode SDK events
   - Diff generation for file edit operations
   - Token usage extraction
   - Model and agent information capture
   - Error handling with graceful degradation

4. **Bridge Plugin Enhancement** (`easy-workflow-bridge.ts`)
   - New hooks: `message.updated`, `tool.execute.after`, `session.updated`
   - Event forwarding to standalone server
   - Session ID extraction and propagation

5. **Server Event Handlers** (`src/server.ts`)
   - `handleMessageEvent()` - Process message events
   - `handleToolExecuteEvent()` - Process tool executions
   - `handleSessionUpdateEvent()` - Track session lifecycle
   - `handleSessionIdleEvent()` - Session completion handling
   - Message logger context management

6. **REST API Endpoints**
   - `GET /api/sessions/:sessionId/messages` - Raw message list
   - `GET /api/sessions/:sessionId/timeline` - Formatted timeline
   - `GET /api/tasks/:taskId/messages` - Messages by task
   - `GET /api/task-runs/:runId/messages` - Messages by task run

## Data Model

### SessionMessage Schema
```
id: INTEGER PRIMARY KEY
message_id: TEXT (OpenCode message ID)
session_id: TEXT NOT NULL (OpenCode session ID)
task_id: TEXT (Workflow task ID)
task_run_id: TEXT (Task run ID for best-of-n)
timestamp: INTEGER NOT NULL (Unix timestamp in ms)
role: TEXT NOT NULL (user/assistant/system/tool)
message_type: TEXT NOT NULL (text/tool_call/tool_result/error/step_finish)
content_json: TEXT NOT NULL (Full message content)
model_provider: TEXT (e.g., anthropic, openai)
model_id: TEXT (e.g., claude-3-5-sonnet)
agent_name: TEXT (Agent that generated message)
prompt_tokens: INTEGER (Token usage)
completion_tokens: INTEGER (Token usage)
total_tokens: INTEGER (Token usage)
tool_name: TEXT (Tool that was called)
tool_args_json: TEXT (Tool arguments)
tool_result_json: TEXT (Tool execution result)
tool_status: TEXT (success/error/pending)
edit_diff: TEXT (Unified diff for file edits)
edit_file_path: TEXT (File that was edited)
session_status: TEXT (Session state)
workflow_phase: TEXT (planning/execution/review)
raw_event_json: TEXT (Complete raw event)
```

## Usage

### For Timeline Reconstruction
```typescript
// Get formatted timeline for a session
const response = await fetch('/api/sessions/abc123/timeline')
const { timeline, messageCount, startTime, endTime } = await response.json()

// Timeline entry format:
{
  id: 1,
  timestamp: 1699900000000,
  relativeTime: 0,  // ms from session start
  role: "assistant",
  messageType: "text",
  summary: "I'll create that file...",
  hasToolCalls: true,
  hasEdits: true,
  modelProvider: "anthropic",
  modelId: "claude-3-5-sonnet",
  agentName: "build"
}
```

### For Analysis
```typescript
// Get all messages for a task
const messages = await fetch('/api/tasks/task-123/messages')

// Get messages for specific task run (best-of-n)
const runMessages = await fetch('/api/task-runs/run-456/messages')
```

## Features

### Automatic Message Capture
- All user prompts
- All assistant responses
- Tool calls and results
- File edit diffs
- Session lifecycle events
- Token usage metrics
- Model information

### Diff Generation
When tools like `file.write` or `file.edit` are executed, the system generates a unified diff comparing the original content with the new content. This enables precise reconstruction of what changed.

### Context Tracking
Each message is automatically linked to:
- Task ID (if in a workflow)
- Task Run ID (for best-of-n execution)
- Workflow phase (planning/execution/review)
- Session status
- Agent name and model

### Error Handling
- Graceful degradation - logging failures don't crash workflows
- Sanitized event storage (circular references handled)
- Large content truncation (10KB limit for raw events)

## Testing

Comprehensive test suite in `tests/message-logging.test.ts` covering:
- Database CRUD operations
- Timeline ordering
- Tool execution with diffs
- Model and token extraction
- Session lifecycle logging
- Error handling
- Integration flow

## Performance Considerations

Current implementation:
- Synchronous inserts for immediate persistence
- Indexes on all query fields
- Efficient JSON serialization
- Connection pooling via SQLite

Future optimizations (Task 8):
- Batch inserts for high-volume scenarios
- Async message queue
- Configurable retention policies
- Message compression

## Migration

The database migration is automatic on server startup:
1. Checks if `session_messages` table exists
2. Creates table with all indexes if missing
3. Foreign keys reference existing tables
4. Backward compatible - no data migration needed

## Security

- No sensitive data in diffs (content is already in git)
- Session IDs are already exposed in URLs
- No user credentials logged
- Raw events sanitized before storage

## API Examples

### Get Session Timeline
```bash
curl http://localhost:3789/api/sessions/abc123/timeline
```

Response:
```json
{
  "sessionId": "abc123",
  "messageCount": 5,
  "startTime": 1699900000000,
  "endTime": 1699900100000,
  "timeline": [
    {
      "id": 1,
      "timestamp": 1699900000000,
      "relativeTime": 0,
      "role": "system",
      "messageType": "session_start",
      "summary": "Session started",
      "hasToolCalls": false,
      "hasEdits": false,
      "modelProvider": null,
      "modelId": null,
      "agentName": null
    },
    {
      "id": 2,
      "timestamp": 1699900020000,
      "relativeTime": 20000,
      "role": "user",
      "messageType": "text",
      "summary": "Create a hello world program",
      "hasToolCalls": false,
      "hasEdits": false,
      "modelProvider": null,
      "modelId": null,
      "agentName": null
    }
  ]
}
```

### Get Raw Messages
```bash
curl http://localhost:3789/api/sessions/abc123/messages
```

## Integration Points

1. **OpenCode Plugin System**
   - Hooks into `message.updated`, `tool.execute.after`, `session.updated`
   - Non-blocking event forwarding
   - Session ID extraction from multiple sources

2. **Workflow System**
   - Links messages to tasks and task runs
   - Tracks workflow phase transitions
   - Supports best-of-n execution tracking

3. **Kanban UI**
   - Ready for timeline visualization
   - WebSocket support for real-time updates
   - REST endpoints for historical data

## Files Modified/Created

**New Files:**
- `src/message-logger.ts` - Message logging service
- `tests/message-logging.test.ts` - Test suite

**Modified Files:**
- `src/types.ts` - Added SessionMessage types
- `src/db.ts` - Added table migration and CRUD methods
- `easy-workflow-bridge.ts` - Added message hooks
- `src/server.ts` - Added event handlers and REST endpoints

## Next Steps (Future Enhancements)

1. **Performance Optimization** (Task 8)
   - Batch message inserts
   - Configurable retention policies
   - Message archiving

2. **UI Integration**
   - Timeline visualization component
   - Message search and filtering
   - Diff viewer for file edits

3. **Analytics**
   - Token usage reporting
   - Model performance metrics
   - Session duration analysis

4. **Export**
   - JSON export for sessions
   - Markdown timeline export
   - Integration with external logging systems