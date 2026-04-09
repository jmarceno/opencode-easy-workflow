# Pi Migration MVP Verification

This document records verification evidence for the OpenCode → Pi migration MVP in `pi-easy-workflow/`.

## Verification run summary

Executed in this repository worktree:

- `bun test` → **45 pass / 0 fail** across **12 files**
- `bun test --coverage` → **87.83% lines**, **87.98% funcs**
- `bun run skills:verify` → setup checks passed
- server smoke start (`PI_EASY_WORKFLOW_PORT=0 bun run src/index.ts`) → startup log emitted successfully

## MVP requirement mapping

| Requirement | Status | Evidence |
|---|---:|---|
| Task creation and dependency-aware execution | ✅ | `tests/server.test.ts` task APIs; `tests/orchestration.test.ts` dependency-chain execution (`startSingle` runs required tasks in order) |
| Plan mode with approval/revision | ✅ | `tests/plan-mode.test.ts` |
| Review loop behavior | ✅ | `tests/review-loop.test.ts` |
| Best-of-n behavior | ✅ | `tests/best-of-n.test.ts` |
| Local session viewing | ✅ | `tests/server.test.ts` session routes + local `/#session/<id>` URL normalization + orchestrated local session view flow |
| Full session data capture in DB | ✅ | `tests/execution.test.ts` asserts `rpc_command`, `rpc_response`, `rpc_event`, `stderr_chunk`, `lifecycle`, `prompt_rendered`, `snapshot`; `tests/db.test.ts` raw + normalized storage |
| DB-backed prompt templates in use | ✅ | `tests/prompts.test.ts` + `tests/db.test.ts` prompt capture and versioning |
| Project-local Pi skills installed/usable | ✅ | `tests/skills-sync.test.ts`; `bun run skills:verify` |
| No permission stalls in MVP runtime | ✅ | `src/runtime/pi-process.ts` default Pi args include `--no-extensions` |

## Added/updated verification tests in this implementation pass

- **Updated:** `tests/execution.test.ts`
  - Added stricter assertions for complete raw capture record types in `session_io`
- **Added:** `tests/orchestration.test.ts`
  - Added orchestration verification for dependency chain execution
- **Updated:** `tests/server.test.ts`
  - Added local session viewer integration flow for real orchestrated execution

## Database persistence confirmation

Confirmed persisted entities include:

- `workflow_sessions` (session ownership + lifecycle)
- `session_io` (append-only raw capture)
- `session_messages` (normalized projection)
- `prompt_templates` (DB-backed canonical prompt store)
- `prompt_template_versions` (template history)

Core prompt keys verified:

- `execution`, `planning`, `plan_revision`, `review`, `review_fix`, `repair`,
  `best_of_n_worker`, `best_of_n_reviewer`, `best_of_n_final_applier`, `commit`

## Runnable state

The project is runnable end-to-end:

1. `bun install`
2. `bun run setup`
3. `bun run src/index.ts`

Smoke evidence captured from startup:

```text
[pi-easy-workflow] server started on http://0.0.0.0:41157
```

## Explicit remaining gaps

See `./MVP_GAPS.md` for the explicit list of remaining MVP-adjacent gaps and post-MVP next steps.
