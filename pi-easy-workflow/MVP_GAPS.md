# Pi Migration MVP Gaps and Next Steps

This file intentionally lists known gaps so they remain explicit.

## Current known gaps

## 1) `startAll` does not dynamically pull newly-unblocked dependency tasks in the same run

- **Current behavior:** `startAll()` resolves task order once at run start.
- **Impact:** if a task is not executable at run start but becomes executable after dependency completion, it may not run in that same `all_tasks` run.
- **Workaround today:** use targeted runs (`startSingle`) for dependency chains (covered by tests).
- **Next step:** re-evaluate executable tasks between task completions during `all_tasks` runs.

## 2) Session viewer live updates are not fully websocket-driven for orchestrated Pi session messages

- **Current behavior:** session data is persisted correctly and available via `/api/sessions/:id/messages` and `/api/sessions/:id/io`, but websocket `session_message_created` broadcast is primarily wired for `/api/pi/sessions/:id/events` route events.
- **Impact:** local session modal can load and display session history, but continuous timeline updates from direct orchestrator Pi stream are not fully pushed as normalized session-message events.
- **Next step:** broadcast `session_message_created` (and relevant status updates) directly from Pi runtime projection path.

## 3) Telegram notification parity is partial

- **Current behavior:** options/fields exist, but migration focus prioritized core orchestration/session capture/DB prompt model.
- **Impact:** notification behavior parity with legacy may be incomplete.
- **Next step:** validate and port exact legacy notification triggers where still needed.

## 4) Fully isolated Pi runtime directory is not implemented in MVP

- **Current behavior:** MVP uses user Pi auth/model defaults and local `.pi/skills` sync.
- **Impact:** runtime is practical for migration but not yet fully deterministic/isolated.
- **Next step:** add optional isolated runtime via `PI_CODING_AGENT_DIR`.

## 5) Interactive local session controls are post-MVP

- **Current behavior:** local session viewer is read-focused; full steering/follow-up/abort controls are limited.
- **Impact:** operator interactivity is reduced compared to future target.
- **Next step:** add explicit steer/follow-up/abort actions in local session viewer and server routes.

## Recommended execution order for next steps

1. Implement dynamic dependency scheduling in `startAll`
2. Add websocket session-message broadcasting from orchestrated Pi runtime
3. Complete Telegram parity check and targeted ports
4. Add optional isolated Pi runtime mode
5. Add interactive session controls
