# Phase 6b — Simulation guide

Two sims exist for the task-driven execution path. One runs in CI on every commit; the other is a manual smoke you run by hand after specific kinds of changes. This doc explains when to reach for each and how to read the live sim's audit.

## The two sims

|                     | Deterministic sim                                        | Live dispatch smoke                                      |
| ------------------- | -------------------------------------------------------- | -------------------------------------------------------- |
| **File**            | `packages/core/src/__tests__/phase6b-simulation.test.ts` | `packages/core/scripts/sim-live-dispatch.ts`             |
| **Runs in**         | `npm test` (CI + local)                                  | Manual only                                              |
| **Runtime**         | Mocked `WorkerRuntime` — test scripts drive verb calls   | Real `PiRuntime` — real LLM, real money                  |
| **What it catches** | Protocol + invariant + concurrency bugs                  | Prompt comprehension, verb selection, end-to-end latency |
| **Cost per run**    | Zero                                                     | A few cents on `grok-4-fast` for the simple cases        |
| **Wall-clock**      | ~5s                                                      | 5–90s depending on goal                                  |
| **Determinism**     | Full                                                     | Model-dependent (Grok may pick different tool orders)    |

The deterministic sim is the first line of defense: it exercises the full wiring (PGlite + bridge + invariant layer + verb adapters + worktree manager) against a scripted mock runtime. It can't validate that the LLM actually picks `complete_task` when the task is done — only that when a worker calls `complete_task`, the plumbing works.

The live smoke fills that gap. It's expensive, non-deterministic, and out-of-band — so we don't wire it into CI. We run it manually when a change could affect how the LLM interprets its tools.

## When to run the live smoke

Run `npm run sim:live -w @neura/core` (with `NEURA_LIVE_SIM=1`) after any of these:

- Changes to `CANONICAL_WORKER_SYSTEM_PROMPT` in `packages/core/src/workers/agent-worker.ts`
- Changes to the `orchestrator-worker-control` skill body (`.neura/skills/orchestrator-worker-control/SKILL.md`)
- Changes to any verb adapter's `name`, `label`, `description`, or parameter schema in `packages/core/src/workers/worker-protocol-tools.ts` — the LLM reads those fields, so wording matters
- Changes to `applyTaskUpdate`'s invariants (new guards could silently trip the worker)
- Changes to `AgentWorker.dispatchForTask` or `PiRuntime.buildSession`
- A worker-route swap in config (new provider, new model)
- Bumps to `@mariozechner/pi-coding-agent` or `@mariozechner/pi-ai`

**Don't bother after:** storage / memory refactors, test-only changes, doc tweaks, UI/desktop work, cost-tracker or discovery-loop changes. These are covered by the deterministic sim and their own unit tests.

## How to run

```bash
# Default goal (writes "hello from a Neura worker" to a tmp file):
NEURA_LIVE_SIM=1 npm run sim:live -w @neura/core

# Custom goal (override via env var):
NEURA_LIVE_SIM=1 NEURA_SIM_GOAL='Your instructions here' npm run sim:live -w @neura/core

# Shorter wall-clock cap for a fast spin (default is 5 min):
NEURA_LIVE_SIM=1 NEURA_SIM_WALL_CLOCK_MS=60000 npm run sim:live -w @neura/core
```

The script reads `~/.neura/config.json` — specifically `routing.worker.provider` + `routing.worker.model` + the matching `providers.<id>.apiKey`. It never touches `~/.neura/pgdata`; everything goes in a fresh `$TMPDIR/neura-live-sim-XXXXXX` that's swept on exit.

Clarifications are auto-answered with `"proceed"` every second so the worker doesn't hang. If you want a clarification path that actually tests answer interpretation, edit the script or write a second variant.

## Exit codes

| Code | Meaning                                                                                |
| ---- | -------------------------------------------------------------------------------------- |
| `0`  | Task reached `done` — worker self-reported success                                     |
| `1`  | Task reached `failed` — worker called `fail_task` or runtime crashed                   |
| `2`  | Anything else (cancelled, timeout, config missing, refusal without `NEURA_LIVE_SIM=1`) |

## Reading the audit

The script prints a JSON audit to stdout on exit. Example shape:

```json
{
  "taskId": "…uuid…",
  "workerId": "…uuid…",
  "status": "done",
  "goal": "…",
  "outputFile": "…",
  "fileExists": true,
  "fileContent": "…",
  "comments": [
    { "type": "progress", "author": "worker:…", "content": "…" },
    { "type": "clarification_request", "urgency": "normal", "content": "…" },
    {
      "type": "clarification_response",
      "author": "orchestrator",
      "metadata": { "resolves_comment_id": "…" },
      "content": "…"
    },
    { "type": "result", "author": "worker:…", "content": "…" }
  ],
  "scratchRoot": "…"
}
```

### What to scan for

| Signal                                                              | What it tells you                                                                                                                           |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `status: "done"` + `result` comment as the last entry               | Happy path. Worker picked `complete_task` correctly.                                                                                        |
| `status: "failed"` + `error` comment with `metadata.reason_code`    | Worker self-terminated via `fail_task`. Check the `reason_code` — `impossible` and `already_done` are benign; `hard_error` is interesting.  |
| Only `progress` / `heartbeat` comments and no terminal              | The worker exited without calling a terminal verb — the prompt probably needs iteration. Check stderr for `pi-runtime` errors.              |
| `clarification_request` without a matching `clarification_response` | The `onAnswer` persistence hook didn't fire. Review fix #1 regressed — check `clarification-bridge.ts` + `worker-protocol-tools.ts` wiring. |
| `approval_request` for an action you'd expect to be auto-reversible | Canonical prompt's reversibility rule is too conservative. Loosen the prompt.                                                               |
| `cannot transition` or `cannot update task` errors in stderr        | The worker hit the invariant layer. Check whether the guard is correct (good signal) or the LLM mis-called a verb (prompt issue).           |
| Long pauses in the JSON output (compare `createdAt` gaps)           | Slow model turn — not necessarily a bug, but noteworthy if it's > 30s between related comments.                                             |

### When something looks wrong

1. Read the `comments` array in order. The audit trail is chronological and tells the whole story.
2. Look at the worker's own wording in `clarification_request` / `result` content. That's the LLM's understanding of the task — mismatches between what it says it did and what actually happened on disk are the most interesting bugs.
3. Check `fileExists` + `fileContent` (if the goal writes a file) against the worker's final summary — does the worker's `result` match reality?
4. If the `status` is wrong, compare the terminal comment type to the task status. `done` should pair with a `result` comment; `failed` with an `error` comment.

## Adding harder scenarios

The current default goal is intentionally trivial. When you want to exercise specific flows, pass a richer `NEURA_SIM_GOAL`:

- **Exercise the clarification round-trip**: `Read <file> and summarize its invariants. Call request_clarification with your summary to confirm accuracy. After the user answers, call complete_task.`
- **Exercise the reversibility rule**: `Delete the file /tmp/neura-sim-target. You MUST call request_approval before acting.` — if the worker skips `request_approval` and just deletes, the prompt's reversibility rule is not landing.
- **Exercise heartbeat**: give the worker a goal that requires multi-step reasoning (reading several files, synthesizing) and watch for `heartbeat` comments. Default 2-minute cadence per the canonical prompt.
- **Exercise fail_task**: `Access the file /root/definitely-not-readable and report its contents.` — worker should call `fail_task` with `reason_code: impossible` or `hard_error`.

Keep goals filesystem-local (scratch dir or `$TMPDIR`) unless you explicitly want to exercise `repo_path` dispatch (which runs `git worktree add -b neura/worker/<id>` against a real repo — see plan §Git Worktree Isolation).

## If the live smoke fails

The JSON audit is usually enough to diagnose. If not:

1. **Re-run** — the model is non-deterministic; a single bad run isn't necessarily a regression.
2. **Check the stderr logs** above the JSON block — pi-runtime errors surface there, not in the audit.
3. **Reproduce with a simpler goal** — start from the default, add complexity one step at a time.
4. **Fall back to the deterministic sim** — if you can reproduce the bug against the mock runtime, the problem is in the code path, not the prompt. If it only fails live, it's a prompt-comprehension issue.

## What the live smoke does NOT exercise

Gaps worth knowing about:

- **Real `git worktree add` with submodules / LFS** — deferred per Phase 6b roadmap. Default goal doesn't set `repoPath`.
- **Resume flow** (`SessionManager.open()` on a persisted session file) — the smoke always dispatches fresh.
- **Voice fanout** — `VoiceFanoutBridge` runs with a no-op interjector. Audio piping is out of scope.
- **Crash recovery** (`AgentWorker.recoverFromCrash`) — sweep runs on startup and finds zero orphans. To exercise, kill the script mid-run and re-launch with the same scratch root (requires editing the script).
- **Multiple concurrent workers** — only one dispatch per run.

Each gap is tracked as a Phase 6b follow-up in `roadmap.md`.
