# Phase 6b — Task-Driven Execution Refactor

> **Version**: Draft v2
> **Date**: 2026-04-18
> **Status**: Pending approval after review round 1
> **Scope**: Core orchestrator ↔ worker protocol + task model overhaul
> **Review round 1**: general-purpose subagent + Codex (gpt-5.4) — 2026-04-18
>
> - 4 blockers + 7 nits + 5 suggestions → incorporated; see §Open Questions for residuals

## Motivation

The current architecture silently conflates two different concepts under "skill":

1. **Skill = capability.** To dispatch a worker to do something, a matching SKILL.md must exist. "Create hello.txt on my desktop" has no direct path to execution — Grok falls back to `create_task` (a DB note, inert) because no file-write skill exists.
2. **Skill = reference documentation** (per agentskills.io spec). Instructions on _how_ to do something domain-specific (e.g., "upload to our CMS" with auth details, endpoint, format).

This conflation produces three problems:

- **Capability gap.** Neura is a listener + note-taker, not a doer, unless pre-authored skills cover the user's request.
- **Authoring overhead.** The "self-extension" pitch (`create_skill` via voice) assumes users author reusable procedures. In practice, users express preferences (→ memory) and one-off tasks (→ work items). Reusable procedures are rare in casual conversation.
- **Ceremony without value.** `run_skill`, `create_skill`, `import_skill`, `allowed-tools` enforcement, draft/promotion flow — all wrap the "skill = capability" misconception. Each adds surface area that downstream work has to navigate.

**The correction.** Skills are reference docs (agentskills.io-compliant). **Tasks** are the primary unit of work. Workers are generic capable agents dispatched against tasks, with a formalized communication protocol back to the orchestrator.

## Mental Model

### Before (current)

```
User → Grok (orchestrator)
           ├─ has 25 tools
           ├─ remember_fact, create_task (inert)
           ├─ run_skill(skillName, description) → Worker
           └─ Worker loads SKILL.md body + allowed-tools scope, executes

Problem: if no matching skill, no path from intent to action.
```

### After (this refactor)

```
User → Grok (orchestrator, "Product Manager")
           ├─ Clarifies goal with user until unambiguous
           ├─ create_task(goal, context, ...) → task row (status: awaiting_dispatch)
           ├─ confirms with user (implicit or explicit)
           ├─ dispatch_worker(taskId) → Worker (spawned in isolated worktree)
           │
Worker (generic "Engineer", pi-coding-agent session)
           ├─ Fetches task context on start
           ├─ Has full tool surface (Read, Write, Edit, Bash, ...)
           ├─ Optionally consults referenced skills as documentation
           ├─ Updates task status + comments via update_task tool
           └─ Communicates via 5-verb protocol

Skills = optional reference documentation, not capabilities.
```

**Role split:**

- **Grok = Product Manager.** Owns goal clarity. Extracts requirements via conversation. Creates well-formed task. Confirms with user before dispatch. Relays worker comments to user as voice.
- **Worker = Engineer.** Owns tactical execution. Consults task context + referenced skills. Escalates only when genuinely blocked. Posts structured progress.
- **Task = JIRA ticket.** Source of truth for status, progress, comments. Survives restarts; audit trail; queryable.

## Communication Protocol

The worker communicates back to the orchestrator via comments on its task row. Six verbs, mapped to comment types:

| Verb                             | Comment type            | Status transition          | User interaction                      |
| -------------------------------- | ----------------------- | -------------------------- | ------------------------------------- |
| `report_progress(msg)`           | `progress`              | —                          | Fire-and-forget; optional voice-relay |
| `heartbeat(msg?)`                | `heartbeat` (pruned)    | —                          | None; refreshes `lease_expires_at`    |
| `request_clarification(q)`       | `clarification_request` | `→ awaiting_clarification` | Requires user answer                  |
| `request_approval(action)`       | `approval_request`      | `→ awaiting_approval`      | Requires user yes/no                  |
| `complete_task(summary)`         | `result`                | `→ done`                   | Terminal; voice-relay summary         |
| `fail_task(reason, reason_code)` | `error`                 | `→ failed`                 | Terminal; voice-relay failure         |

**Important:** these verbs don't become separate tools. They're encoded in a single `update_task(taskId, payload)` tool where the payload shape + validation determines the verb.

**Heartbeat semantics.** Long-running workers (codegen, multi-file refactors) must emit `heartbeat` at least every N minutes (default: 2) to refresh `lease_expires_at`. The orchestrator's orphan-sweep logic treats tasks with stale leases as crash candidates. `heartbeat` comments are pruned after the next comment from the same worker to avoid DB bloat; semantics are "I'm alive," not "I made progress" — use `report_progress` for the latter.

**`fail_task.reason_code` enum:**

- `impossible` — task cannot be completed as specified (missing dependency, invalid precondition)
- `already_done` — worker detected the goal is already satisfied (no-op)
- `user_aborted` — worker stopped voluntarily after a user clarification directed it to
- `hard_error` — something actually broke (exception, tool failure, timeout)

Distinct from `status: cancelled` (user explicitly cancelled via orchestrator), `failed(already_done)` lets the orchestrator relay "actually, that was already done" as success-without-action rather than as a failure.

**Reversibility rule** (embedded in worker system prompt): `request_approval` is mandatory before any destructive or hard-to-undo action (`rm`, force-push, overwriting a user file, sending external messages, spending money, etc.). For reversible reads and internal writes (creating new files in the worker's own worktree, running tests), just act.

## Ticket-as-State-of-Truth

### Unified attention model

Every orchestrator → user interjection is a task with a `status` or `source` that marks it as needing attention. No separate escalation queue.

- **Worker clarifications/approvals** → `awaiting_clarification` / `awaiting_approval` status on the task
- **Worker completions** → `done` status + `result` comment
- **Discovery Loop proactive pushes** (calendar, deadlines) → system-generated task rows with `source: 'system_proactive'`
- **Task deadline reminders** → system comments on the task

Orchestrator "what needs my attention?" becomes `list_tasks({ needs_attention: true })`, where `needs_attention` is precisely defined as:

```sql
status IN ('awaiting_clarification', 'awaiting_approval')
OR source = 'system_proactive' AND status = 'pending'
OR (status = 'awaiting_dispatch' AND created_at < now() - interval '5 minutes')  -- stale user-confirmation pauses
```

### Transport vs state

- **Tickets (tasks + comments) are the durable state of truth.**
- **ClarificationBridge** (already exists) demotes to transport optimization: notifies a live orchestrator immediately when a comment is posted, so ACTIVE-mode escalations have no artificial delay.
- If the orchestrator is IDLE/PASSIVE, comments sit on the ticket; orchestrator finds them on next `get_system_state()` call.

### Urgency policy

- `critical` → bridge interrupts orchestrator (or triggers push notification when IDLE — Phase 7). Destructive actions only.
- `high` → jumps queue position but waits for active topic to finish.
- `normal` / `low` → natural FIFO by `blocked_since`.

### Concurrency

**The problem:** `update_task` is called by both workers (posting progress, transitioning status) and the orchestrator (relaying user answers, cancelling). Without explicit coordination, a user saying "cancel that" at the exact moment the worker posts `complete_task` produces ambiguous state.

**Solution:**

1. **Optimistic locking.** `work_items` gains a `version` integer column. Every `update_task` call increments it via `UPDATE ... SET version = version + 1 WHERE id = $1 AND version = $2`. Zero rows affected → the handler retries with the fresh version or returns a `version_conflict` error to the caller.

2. **Transition matrix.** The `update_task` handler enforces allowed status transitions in code (not DB constraint — easier to evolve). Example rules:
   - From `in_progress` → `awaiting_*`, `done`, `failed`, `cancelled`, `paused` (worker or orchestrator)
   - From `awaiting_clarification` → `in_progress` (on user answer), `cancelled` (user abort), `failed` (lease expiry)
   - From `done` / `failed` / `cancelled` → (terminal, no transitions)
   - Workers may NOT transition to `cancelled` (orchestrator-only)
   - Orchestrator may NOT transition to `done` (worker-only; orchestrator must cancel)

3. **Terminal-race precedence.** If a worker posts `complete_task` and the orchestrator concurrently issues `cancel`, the version-check resolves it: whichever commits first wins, the loser gets `version_conflict`. The orchestrator-side handler on conflict re-reads the task: if it's now `done`, the cancel is reported to the user as "too late — already completed." If it's `cancelled`, the worker's `complete_task` becomes a no-op comment (the result is preserved for audit, status stays `cancelled`).

4. **Comment writes don't version-lock.** Only status transitions require the `version` guard. Pure comment appends (e.g. `heartbeat`, `progress`) are lock-free — they can't conflict with anything meaningful.

### Handler-level backstops

Prompt-level discipline is fallible. A few cheap invariants enforced by the `update_task` handler (not the LLM):

- Reject `complete_task` while an unresolved `approval_request` comment exists (worker must wait for resolution, or `fail_task`).
- Reject worker-originated comments that attempt `author: 'user'` or `author: 'orchestrator'`.
- Reject cross-task writes: a worker may only update its own task (`task.worker_id === worker.id`).
- Reject terminal-status transitions from non-terminal statuses by the wrong actor (per transition matrix above).

These fire as `InvalidUpdateError` back to the caller; the LLM sees the rejection and can adjust.

### Active-conversation discipline

No code-level "currently active escalation" pointer. The orchestrator's system prompt handles this:

> _"Complete the current topic with the user before raising the next attention ticket, unless the new ticket is `critical` urgency. On detour (user asks unrelated question), handle it, then re-raise the topic."_

This is prompt-level convention, not enforced by state. The orchestrator's natural conversational flow is the active-item pointer.

### Deferral

User says "I'll come back to this later" → orchestrator posts a `deferred` comment + leaves status as `blocked_*`. The **Discovery Loop** is the main driver for re-surfacing deferred items on its existing 15-min cadence.

## Tool Surface Changes

### Removed (stubs + deprecated)

- `run_skill` — replaced by `dispatch_worker(taskId)`
- `create_skill` — stub, broken; authors use editor + `neura skill validate`
- `import_skill` — stub, not wired
- Skill `allowed-tools` runtime enforcement (`beforeToolCall` hook, `MINIMAL_DEFAULT_ALLOWED_TOOLS` fallback, absence warning)

### Added

| Tool                           | Purpose                                                                                                                       |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| `update_task(taskId, payload)` | Unified: comments + status + field updates. Workers + orchestrator, scoped by author via system prompt.                       |
| `dispatch_worker(taskId)`      | Kicks off a worker against an existing (briefed) task.                                                                        |
| `get_system_state()`           | Single snapshot: active workers, attention-required tickets, recent completions, upcoming deadlines, pending proactive items. |

### Evolved

- `list_tasks(filter)` — adds `needs_attention` (predicate defined in §Ticket-as-State-of-Truth), `source`, `status[]`, `since` filter params. Replaces any specialized `get_attention_tickets`.
- `create_task` — enriched with `goal`, `context` (JSONB), `related_skills` (string[]), `repo_path` fields.

### Kept as-is

- Memory tools (`remember_fact`, `recall_memory`, `update_preference`, `invalidate_fact`, `get_timeline`, `memory_stats`)
- Vision tools (`describe_camera`, `describe_screen`)
- Time (`get_current_time`)
- Presence (`enter_mode`)
- Task CRUD read tools (`get_task`, `delete_task`)
- Worker control (`pause_worker`, `resume_worker`, `cancel_worker`, `list_active_workers`)
- Skills introspection (`list_skills`, `get_skill`, `promote_skill`)

### Net tool count

25 → 25. Three removed (`run_skill`, `create_skill`, `import_skill`), three added (`update_task`, `dispatch_worker`, `get_system_state`). The win is per-tool semantic clarity and behavior, not count reduction.

## Schema Changes

### `work_items` table — expand

**New fields:**

| Column             | Type      | Description                                                                                                            |
| ------------------ | --------- | ---------------------------------------------------------------------------------------------------------------------- |
| `goal`             | TEXT      | User's stated success condition. Distinct from free-form `description`.                                                |
| `context`          | JSONB     | Structured: `{ references: [], constraints: [], acceptance_criteria: [] }`.                                            |
| `related_skills`   | TEXT[]    | Skill names to load as reference docs at worker dispatch.                                                              |
| `repo_path`        | TEXT      | Absolute path to user repo (for git-worktree dispatch). Nullable.                                                      |
| `base_branch`      | TEXT      | Branch for `git worktree add`. Defaults to HEAD.                                                                       |
| `worker_id`        | TEXT      | FK to `workers.id` once dispatched. Nullable.                                                                          |
| `source`           | TEXT      | `'user'` \| `'system_proactive'` \| `'discovery_loop'`. Default `'user'`.                                              |
| `version`          | INTEGER   | Optimistic-lock counter; incremented on every `update_task`. Default 0.                                                |
| `lease_expires_at` | TIMESTAMP | Worker's heartbeat-refreshed lease. Null when task is not in a `running`-class status. Stale lease → orphan candidate. |

**Expanded status enum:**

```
pending                   (existing)
awaiting_dispatch         (new — task fully briefed, awaiting user confirmation before dispatch)
in_progress               (existing)
awaiting_clarification    (new — worker needs user input; distinct from WorkerStatus.blocked_clarifying)
awaiting_approval         (new — worker needs user yes/no on a destructive action)
paused                    (new — user-initiated pause)
done                      (existing — NOT renamed to `completed` to avoid migration churn)
failed                    (existing)
cancelled                 (existing)
```

**Naming note.** `WorkerStatus` (in `workers` table) and `WorkItemStatus` (in `work_items` table) are distinct enums with overlapping-but-different semantics. `blocked_clarifying` remains on `WorkerStatus` (pi-session-level state); `awaiting_clarification` is the new `WorkItemStatus` (task-level state). A worker may be `blocked_clarifying` while its task is `awaiting_clarification` — same underlying reality, observed at different layers.

### Crash-recovery disposition

At core startup, the recovery sweep evaluates every non-terminal `work_items` row. New dispositions:

| Status at crash                 | Recovery behavior                                                                                                                                                                       |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pending`                       | Preserve — never dispatched; can be picked up fresh                                                                                                                                     |
| `awaiting_dispatch`             | Preserve — fully briefed but never dispatched; user may confirm later                                                                                                                   |
| `in_progress`                   | If `lease_expires_at < now()`: mark `failed(reason_code: hard_error, reason: 'worker crashed')`. Else: associated worker row recovery applies (existing Phase 6 logic)                  |
| `awaiting_clarification`        | Preserve — durably blocked on user. Associated worker session re-attaches if `session_file` valid; else mark `failed(reason_code: hard_error, reason: 'worker_lost')` on resume attempt |
| `awaiting_approval`             | Same as `awaiting_clarification`                                                                                                                                                        |
| `paused`                        | Preserve — user-initiated; resumable                                                                                                                                                    |
| `done` / `failed` / `cancelled` | Terminal; no action                                                                                                                                                                     |

Any associated `workers` row whose task ended up in a terminal failure gets its status synchronized (e.g. `failed` → worker also marked `crashed`).

### `task_comments` table — new

```sql
CREATE TABLE task_comments (
  id            TEXT PRIMARY KEY,
  task_id       TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
  type          TEXT NOT NULL,   -- 'progress' | 'heartbeat' | 'clarification_request'
                                 -- | 'approval_request' | 'clarification_response'
                                 -- | 'approval_response' | 'error' | 'result'
                                 -- | 'system' | 'deferred'
  author        TEXT NOT NULL,   -- 'worker:<workerId>' | 'orchestrator' | 'user' | 'system'
  content       TEXT NOT NULL,   -- max 32KB; longer content overflows to attachments_path
  attachment_path TEXT,          -- optional: path under ~/.neura/worktrees/<workerId>/_attachments/
  urgency       TEXT,            -- 'low' | 'normal' | 'high' | 'critical' — only for *_request types
  metadata      JSONB,
  created_at    TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_task_comments_task_id ON task_comments(task_id);
CREATE INDEX idx_task_comments_type ON task_comments(type);
CREATE INDEX idx_task_comments_created_at ON task_comments(created_at);
```

**Content size policy:**

- Soft limit: 32 KB per comment (covers most test failures, diff summaries, error tracebacks).
- Overflow: the `update_task` handler writes content exceeding the limit to `<worktree>/_attachments/<comment-id>.txt` and stores the path in `attachment_path`. The `content` column gets a short summary (first/last N lines + marker).
- Heartbeat comments are pruned after the next comment from the same worker to prevent unbounded growth on long-running tasks.

### Migration strategy

- Breaking change (Phase 6b is a major refactor; no v2 backward-compat for tasks)
- Single migration script: add columns, add status enum values, create `task_comments` table
- Existing task rows get `status` preserved; `goal`/`context`/`source` backfilled with sensible defaults
- Any in-flight task with `status = 'in_progress'` at migration time is force-transitioned to `failed(reason_code: hard_error, reason: 'migration_reset')` — safer than leaving phantom workers referencing a pre-migration schema
- `version` backfills to 0; `lease_expires_at` backfills to NULL

## Worker Runtime Changes

### Current

- `dispatch(task: WorkerTask, ...)` where `WorkerTask = { taskType, skillName?, description, context? }`
- `taskType: 'execute_skill'` with `skillName` couples dispatch to skill registry
- Worker system prompt is pi's default (coding agent) + task description
- `beforeToolCall` hook enforces `allowed-tools` from the executing skill

### After

- `dispatch(taskId: string, ...)` — worker fetches task by ID on start
- Worker system prompt is the **canonical Neura worker prompt** (defined below) + task context
- No permission hook. Workers have pi's full tool surface (Read, Write, Edit, Bash, etc.) scoped only by the worktree (filesystem isolation) and their own prompt discipline (reversibility rule).
- Referenced skills (`task.related_skills`) loaded as reference documentation into the worker's prompt

### Task-ID dispatch flow

```
orchestrator.dispatch_worker(taskId)
  → AgentWorker.dispatch(taskId)
     1. Fetch work_items row by ID
     2. Create git worktree at ~/.neura/worktrees/<workerId>/
        (from task.repo_path + task.base_branch, or just mkdir if no repo)
     3. Resolve task.related_skills → load SKILL.md bodies as reference
     4. Build worker system prompt: canonical + task context + reference skills
     5. Create pi AgentSession with cwd = worktree path
     6. session.prompt(<task.goal + task.description + acceptance_criteria>)
     7. Worker runs, posts comments via update_task, terminates
     8. Cleanup worktree based on terminal status
```

## Canonical Prompts

### Worker system prompt (NEW)

A single canonical prompt injected into every worker AgentSession. Defines:

1. **Role:** You are a Neura worker — a capable engineering agent executing a task dispatched by the Neura orchestrator.
2. **Your task:** Your current task is in `<task>…</task>` below. Read it, execute it, report back.
3. **Tool posture:** You have access to Read, Write, Edit, Bash within your isolated worktree. Be decisive.
4. **Reversibility rule:** Before any destructive or hard-to-undo action outside your worktree, call `update_task` with an `approval_request` comment and wait for the user's answer via a corresponding `approval_response`.
5. **The 6-verb protocol:** How to report progress, heartbeat on long tasks, request clarification, request approval, complete, fail (with reason_code). Each with concrete examples of when to use.
6. **Escalation discipline:** Escalate sparingly. Try to resolve ambiguities from context first. Only escalate when you genuinely cannot proceed without user input.
7. **Heartbeat cadence:** For any task that will run longer than 2 minutes, emit `heartbeat` at least every 2 minutes so the orchestrator doesn't treat you as crashed.
8. **Reference skills:** If `<reference_skills>` is populated, consult them as domain documentation — not as executable code. Reference skills are snapshotted at dispatch time — a skill edited mid-run won't affect an already-running worker (revisit if this proves problematic).

Target: ~500-700 words. Stable across worker invocations; task-specific content injected around it.

### Orchestrator system prompt additions (UPDATE)

Add to existing orchestrator prompt (or the `orchestrator-worker-control` skill):

1. **PM role:** Before creating a task, verify you can write a clear success criterion. If you can't, ask the user another clarifying question first.
2. **Task creation separation:** `create_task` creates the row (status: `awaiting_dispatch`). `dispatch_worker(taskId)` kicks off execution. Use the pause between them to confirm intent with the user, especially for non-trivial or destructive tasks.
3. **Confirmation policy:** Bypass confirmation for reversible/trivial actions ("fetch my email", "read recent tasks"). Always confirm for destructive or external-facing actions ("delete X", "send email to Y", "spend money on Z").
4. **Attention ticket handling:** At the start of every conversation (and opportunistically after long pauses), call `get_system_state()`. Walk through attention items one at a time. Complete the current topic before raising the next, unless it's `critical`.
5. **User answer relay:** When relaying a user's answer to a worker's clarification/approval, post it back via `update_task` with the matching response type. This is how the worker unblocks.

## Git Worktree Isolation

### Motivation

Concurrent workers must not stomp each other's filesystem state (branches, working trees, staged changes, scratch files). Worktree isolation is the mechanism.

### Design

- **Base directory:** `~/.neura/worktrees/<workerId>/` (configurable via `worktreeBasePath` in config)
- **Repo-scoped tasks** (`task.repo_path != null`): `git worktree add <base>/<workerId> <branch>` from the source repo
- **Non-repo tasks**: `mkdir <base>/<workerId>` — plain scratch sandbox
- **Worker `cwd`** always = the worker's worktree path

### Lifecycle

| Terminal status        | Cleanup action                                            |
| ---------------------- | --------------------------------------------------------- |
| `done`                 | Auto-clean immediately (`git worktree remove` + `rm -rf`) |
| `failed` / `cancelled` | Retain `worktreeRetentionHours` (default 24h), then sweep |
| `crashed` (core died)  | Swept on core startup recovery                            |

### Config

```json
{
  "worktreeBasePath": "~/.neura/worktrees",
  "worktreeRetentionHours": 24,
  "worktreeMaxTotalBytes": 21474836480
}
```

### Worktree risks

Creating/removing git worktrees on every worker dispatch surfaces several failure modes. The dispatch + sweep logic needs to handle each:

| Risk                                           | Mitigation                                                                                                                                                                                                                                                                                                   |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Submodules / LFS**                           | `git worktree add` does not initialize submodules or hydrate LFS pointers. If `task.repo_path` has submodules, run `git submodule update --init` after creating the worktree; LFS hydration via `git lfs pull` if `.gitattributes` indicates LFS. Add a `task.context.submodules` hint to let tasks opt out. |
| **User runs `git worktree prune` manually**    | Detect via `git worktree list` discrepancy at next update; if the worker's worktree is gone, mark task `failed(reason_code: hard_error, reason: 'worktree_vanished')` and stop the session.                                                                                                                  |
| **Disk exhaustion**                            | Enforce `worktreeMaxTotalBytes` cap (default 20 GB). Sweep sorts by age on retention and evicts as needed; new dispatches block with `DiskPressure` error if the cap is already met.                                                                                                                         |
| **`.gitignore`d files / build caches missing** | `git worktree add` creates a fresh working tree with no `node_modules`, no `target/`, no caches. Workers must plan to rebuild. If a task depends on existing build state, use `task.context.copy_paths` to specify what to copy from the source repo.                                                        |
| **Windows long paths / permissions**           | `~/.neura/worktrees/<workerId>/` can exceed MAX_PATH on deep repos. Use short workerIds (10 chars hash, not UUIDs); document the limitation in CLI install checks for Windows users.                                                                                                                         |
| **Orphaned worktrees at startup**              | Sweep enumerates `worktreeBasePath` at core startup, cross-references `workers` table — any directory without a live worker row gets `git worktree remove --force` + `rm -rf`.                                                                                                                               |
| **Concurrent worktree add on same repo**       | Safe — `git worktree add` is atomic per-worktree. Parallel dispatches to the same repo produce distinct worktrees.                                                                                                                                                                                           |

## Implementation Waves

Each wave is independently reviewable and committable.

### Wave 1 — Remove stubs + deprecated plumbing

- Delete `run_skill`, `create_skill`, `import_skill` tool defs + handlers + tests
- Delete `allowed-tools` runtime enforcement (`beforeToolCall` hook, `MINIMAL_DEFAULT_ALLOWED_TOOLS`, absence-warning diagnostic)
- Keep `allowed-tools` frontmatter parsing (still spec-valid, used by validator)
- Update `orchestrator-worker-control` SKILL.md (remove run_skill references)

**Risk:** low. Pure deletions + tests.

### Wave 2 — Schema migration

- Expand `work_items` status enum (4 new values)
- Add `goal`, `context`, `related_skills`, `repo_path`, `base_branch`, `worker_id`, `source` columns
- Create `task_comments` table + indices
- Update types in `@neura/types` (TaskStatus, WorkItemEntry, TaskCommentEntry)
- Migration script + backward-compat shim for any in-flight tasks at upgrade time

**Risk:** medium. Breaking change to task schema; tests need updating.

### Wave 3 — Worker runtime rewrite

Split into three passes for reviewability:

**Pass 1** (shipped, `5f02e51`):

- Orchestrator tool surface: `dispatch_worker`, `get_system_state`, unified `update_task`
- Types: `TaskSummary`, `SystemStateSnapshot`, handler interfaces
- `WorkerDispatchHandler` and `SystemStateHandler` stubbed (undefined on ctx)

**Pass 2** (upcoming): dispatch wiring

- Rewrite `AgentWorker.dispatch(taskId)` — fetch task row, build canonical prompt from task.goal + context + related_skills
- Implement `WorkerDispatchHandler` in lifecycle.ts
- Implement `SystemStateHandler` (queries existing tables; no new schema)
- Drop `WorkerTask.taskType` / `skillName` coupling
- Git worktree base-dir management + dispatch integration
- **Hard prerequisites before Pass 2 merges (do not ship without):**
  - `ctx.actor` wired through PiRuntime tool context so the handler knows who is calling `update_task`
  - Handler enforces `task.worker_id === worker.id` for worker-originated updates (blocks cross-task writes; see §Concurrency → Handler-level backstops)
  - Transition-matrix enforcement: worker may NOT transition to `cancelled`; orchestrator may NOT transition to `done`; `done`/`failed`/`cancelled` are terminal
  - `countOpenRequests` called before accepting `complete_task` — reject if an unresolved `approval_request` comment exists
  - Worker may NOT author comments with `author: 'user'` or `author: 'orchestrator'`

**Pass 3** (upcoming): worker protocol tools

- Add pi AgentTool adapters for the 6 worker verbs (`report_progress`, `heartbeat`, `request_clarification`, `request_approval`, `complete_task`, `fail_task`) that wrap `update_task`
- Demote `ClarificationBridge` to transport optimization; task comments are SoT
- `VoiceFanoutBridge` updated: progress comments → ambient voice

**Risk:** high. Load-bearing change; lots of tests to rewire.

### Wave 4 — get_system_state, worktrees, canonical prompts

- Implement `get_system_state()` tool
- Global worktree base dir management + dispatch integration
- Draft + iterate canonical worker system prompt
- Update orchestrator system prompt (or `orchestrator-worker-control` skill)

**Risk:** medium. Prompts need iteration against real scenarios.

### Wave 5 — Tests, docs, verification

- Full test sweep (unit + integration)
- Update `packages/types/src/memory.ts` (WorkItemStatus) and `packages/types/src/workers.ts` barrels
- Update any design-system hooks / components consuming task shapes
- Update `phase6-os-core.md` to reflect new model (deprecate or rewrite relevant sections)
- Update `cli/README.md` if CLI command surface changes
- Run typecheck / lint / test / Codex review
- Update `roadmap.md` to reflect Phase 6b completion

**Risk:** low. Verification.

## Observability

Pin logging namespace conventions up front so debugging the new surface is tractable. All via `@neura/utils` `Logger`:

| Namespace                      | What logs here                                                                        |
| ------------------------------ | ------------------------------------------------------------------------------------- |
| `neura:worker:<workerId>`      | Worker lifecycle (dispatch, session.prompt, terminal status, cleanup)                 |
| `neura:orchestrator:attention` | `get_system_state` calls, attention-item surfacing, escalation resolution             |
| `neura:worktree`               | Worktree creation, cleanup, orphan sweep, disk-cap pressure                           |
| `neura:task:update`            | `update_task` calls (with redacted content), version conflicts, transition rejections |
| `neura:task:lease`             | Heartbeat receipts, lease expiry, orphan-candidate detection                          |

Structured fields pinned: `workerId`, `taskId`, `status`, `fromStatus`, `version`, `urgency` — JSON-queryable via existing log pipeline.

**Metrics the logs must support answering:**

- How often does the orchestrator call `get_system_state` and how often does it find non-empty attention?
- How long do tasks sit in `awaiting_clarification` / `awaiting_approval` before resolution?
- How often do version-conflict rejections happen? (Signal for prompt discipline issues)
- Are workers missing heartbeat deadlines? By how much?

## Decisions Locked In

From the brainstorm:

1. **`run_skill` removed entirely.** No alias or backward-compat. Execution flows through `dispatch_worker(taskId)`.
2. **`allowed-tools` runtime enforcement removed entirely.** Re-add if a concrete use case surfaces. Parsing + validator checks stay.
3. **Confirmation flow:** bypass for trivial/reversible; confirm for destructive. Enforced via orchestrator system prompt, not code.
4. **Context responsibility:** Grok (PM) owns goal-level clarity before task creation. Worker (engineer) owns tactical clarifications during execution.
5. **Six protocol verbs** to start (`report_progress`, `heartbeat`, `request_clarification`, `request_approval`, `complete_task`, `fail_task` with `reason_code`). Iterate as needed.
6. **Unified `update_task` tool** instead of six separate comment-writing tools.
7. **`list_tasks(filter)` enhanced** instead of specialized `get_attention_tickets`.
8. **`get_system_state()` as a single snapshot tool** — no caching (local DB, freshness wins).
9. **Ticket-as-state-of-truth**, no separate `InterjectionQueue`. ClarificationBridge becomes transport optimization.
10. **Git worktrees for filesystem isolation**, global base dir `~/.neura/worktrees/<workerId>/`, configurable.
11. **Audio-only interjection for v1.** UI surface deferred to Phase 7.
12. **Discovery Loop drives deferral resurface** (its existing 15-min cadence).

## Out of Scope

- **`create_skill` authoring flow.** Users author SKILL.md via editor + `neura skill validate`. Voice-authoring revisited post-Phase 6b.
- **Skill testing framework.** No concrete consumer. Deferred until real need surfaces.
- **Bootstrap "workhorse" skills.** If skills are reference docs, not capabilities, bootstrap is less urgent. Revisit based on post-refactor user feedback.
- **Desktop/web UI surface for attention tickets.** Phase 7.
- **Cross-worker escalation batching** (3 workers all asking "which branch?"). Worktree isolation reduces the need; revisit if it surfaces.
- **Convo-history fetch tool.** Deferred; existing session transcripts + memory should suffice.
- **Mid-run crash recovery for workers.** Phase 6 recovery policy (idle_partial only) preserved; extending to blocked_clarifying is future work.

## Open Questions

1. **Task comment retention.** Comments grow unbounded for long-lived tasks. Keep all? Archive after task terminal + N days? Not urgent; defer to Phase 7 cleanup.
2. **`related_skills` resolution when a skill is deleted.** Log warning, continue without it. Include in tests — covered by Wave 3 test scope.
3. **Reference skills snapshot vs live.** Currently designed as snapshot-at-dispatch. A skill edited mid-run won't reach the running worker. Revisit if user-facing problems surface; until then, document behavior.
4. **Heartbeat cadence tuning.** Default 2-minute interval — is that right for all workloads? Long-running refactor tasks might benefit from longer; short probes from shorter. Possibly make per-task configurable later.
5. **Worker restart-on-answer resumption.** When user posts `clarification_response` to a worker that was in `awaiting_clarification` for >5 minutes, does the session bridge still have the pi session alive? If not, need a re-attach path via pi's `SessionManager.open()` + session_file. Phase 6 has precedent; confirm in Wave 3 implementation.
6. **Multi-tenant / multi-user (future).** Current model assumes single user. When we go multi-user, `author: 'user:<userId>'` needs plumbing. Out of scope now; flag in comments table design so it's easy to extend.

Resolved by this revision (previously open):

- ~~Comment length limits~~ → 32 KB soft cap, overflow to attachment.
- ~~Orphaned workers~~ → Handled by lease + worktree retention + startup sweep.
- ~~Worker impersonating user~~ → Handler-level backstop rejects (§Concurrency).
- ~~Worker touching other workers' tasks~~ → Handler enforces `task.worker_id === worker.id` (§Concurrency).

## Approval Checklist

Before implementation starts:

- [ ] Mental model (Grok = PM, Worker = Engineer, Skill = reference docs) accepted
- [ ] Six-verb protocol accepted (`report_progress`, `heartbeat`, `request_clarification`, `request_approval`, `complete_task`, `fail_task` + reason_code)
- [ ] Tool surface changes (removals, additions, evolutions) accepted
- [ ] Schema changes (new columns, new table, expanded status enum, `version`, `lease_expires_at`) accepted
- [ ] Status renames to avoid `WorkerStatus`/`WorkItemStatus` collision (`awaiting_clarification`, `awaiting_approval`, `awaiting_dispatch`, `paused`) accepted
- [ ] Concurrency model (optimistic lock, transition matrix, terminal-race precedence, handler backstops) accepted
- [ ] Crash-recovery disposition table accepted
- [ ] Worker runtime rewrite approach (task-ID dispatch, canonical prompt) accepted
- [ ] Worktree isolation design + risk mitigations accepted
- [ ] Observability namespace conventions accepted
- [ ] Breaking-change stance accepted (no v2 task-model backward-compat)
- [ ] Implementation waves ordering accepted
- [ ] Out-of-scope list agreed — nothing critical missing

## Post-implementation success criteria

- **Capability gap closed.** "Create hello.txt on my desktop" results in Grok creating a task, confirming, dispatching a worker, and the file existing on the desktop.
- **Escalation flow works.** A worker hitting clarification blocks, orchestrator surfaces the question to user, answer relayed back, worker resumes.
- **Multiple concurrent workers with escalations don't overlap.** User sees one at a time via natural conversational flow; none are silently lost.
- **Worktree isolation prevents cross-worker interference.** Two workers modifying the same repo don't corrupt each other's branches.
- **Existing functionality preserved.** Memory, vision, presence, task CRUD, worker control, skill loader, validator, CLI — all continue to work.
