/**
 * Phase 6 — PiRuntime
 *
 * Concrete `WorkerRuntime` implementation backed by the pi-coding-agent
 * SDK. Composes the Phase 1 and Phase 2 building blocks:
 *
 *   pi.createAgentSession()      — spins up a new AgentSession
 *   pi.SessionManager.create()   — file-backed JSONL for new tasks
 *   pi.SessionManager.open()     — reopens idle_partial workers from disk
 *                                   (restart-safe resume, verified by
 *                                   Spike #4e)
 *   buildNeuraTools()            — pi AgentTool adapters over Neura's
 *                                   existing tool handlers
 *   session.subscribe()          — event stream piped to VoiceFanoutBridge
 *                                   (synchronous push, async drain)
 *
 * Phase 6b removed the `beforeToolCall` permission hook (per-skill
 * `allowed-tools` enforcement). Workers have full pi tool access; task
 * dispatch + git-worktree isolation + prompt-level reversibility rule
 * replace it.
 *
 * The runtime is stateful: it tracks active workers in a map keyed by
 * `workerId`. Callers (agent-worker.ts, task dispatch) resolve
 * worker references by id rather than by handle, so persisting ids in
 * PGlite doesn't require holding a runtime reference.
 *
 * IMPORTANT: this module is NOT imported from server.ts yet. Phase 2
 * step 8 (agent-worker.ts) wires it in at startup. Until then, this file
 * is dead code from the bundler's point of view and tree-shakes cleanly.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  type AgentSession,
  type AgentSessionEvent,
  type AuthStorage,
} from '@mariozechner/pi-coding-agent';
import type { Agent, AgentEvent } from '@mariozechner/pi-agent-core';
import type { Model } from '@mariozechner/pi-ai';
import type { WorkerCallbacks, WorkerResult, WorkerStatus } from '@neura/types';
import { Logger } from '@neura/utils/logger';
import { toPiSkillShape, type SkillRegistry } from '../skills/skill-registry.js';
import type { NeuraAgentTool } from './neura-tools.js';
import type { VoiceFanoutBridge } from './voice-fanout-bridge.js';
import type { ResumeParams, WorkerHandle, WorkerRuntime } from './worker-runtime.js';

const log = new Logger('pi-runtime');

/** Events from pi-agent-core that the voice fanout bridge understands. */
const BRIDGE_EVENT_TYPES = new Set<string>([
  'agent_start',
  'agent_end',
  'turn_start',
  'turn_end',
  'message_start',
  'message_update',
  'message_end',
  'tool_execution_start',
  'tool_execution_update',
  'tool_execution_end',
]);

function isBridgeEvent(event: AgentSessionEvent): event is AgentEvent {
  return BRIDGE_EVENT_TYPES.has(event.type);
}

/**
 * Injection surface for PiRuntime. Constructed once at server startup
 * and held for the lifetime of the core process.
 */
export interface PiRuntimeOptions {
  /** Model + thinking level to use for every worker. Pi uses Model<any>. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  model: Model<any>;
  thinkingLevel?: 'off' | 'low' | 'medium' | 'high' | 'xhigh';

  /** Working directory for pi sessions and agentDir. */
  cwd: string;

  /**
   * Absolute path to the pi agent directory (for auth storage, model
   * registry, etc.). Typically `~/.neura/agent`. Neura manages its own
   * directory so it doesn't collide with a user running pi standalone.
   */
  agentDir: string;

  /**
   * Directory where file-backed session JSONLs live. Typically
   * `{agentDir}/sessions`. Each worker writes its transcript here.
   */
  sessionDir: string;

  /**
   * Factory that builds the full pi tool set for a new worker. Called
   * once per `createAgentSession` with the worker id so per-worker
   * custom tools (e.g. `request_clarification`) can close over the
   * id for status updates and callback routing. `taskId` is populated
   * by the Phase 6b task-driven dispatch path so worker protocol tools
   * (report_progress, complete_task, …) can close over it and post to
   * the right work_items row.
   */
  buildTools: (ctx: { workerId: string; taskId?: string }) => NeuraAgentTool[];

  /** Voice fanout bridge. Shared across workers — one per active voice session. */
  voiceFanoutBridge: VoiceFanoutBridge;

  /**
   * Skill registry. Used by `listWorkerSkills()` to populate pi's
   * resource loader with Neura skills as reference documentation.
   */
  skillRegistry: SkillRegistry;

  /**
   * Optional auth storage override. Defaults to pi's own behavior
   * (a file-backed `AuthStorage.create(agentDir/auth.json)`). Tests
   * pass an `AuthStorage.inMemory()` seeded with a dummy key for the
   * faux provider so `createAgentSession` doesn't error out on
   * missing credentials for a fake API.
   */
  authStorage?: AuthStorage;
}

/**
 * Per-worker state the runtime holds in memory. Separate from the
 * `workers` table row, which lives in PGlite — this struct is the
 * handles and callbacks the runtime needs during execution.
 */
interface ActiveWorker {
  workerId: string;
  session: AgentSession;
  /**
   * Legacy field — will be replaced by `taskId` in Wave 3 when worker
   * dispatch moves to task-ID-based lookup. Still populated so existing
   * tests and log surfaces keep working until the rewrite lands.
   */
  skillName: string | undefined;
  /** Resolver for the `done` promise on the returned handle. */
  resolveDone: (result: WorkerResult) => void;
  /** Resolver queue for `waitForIdle()` — all resolved on next agent_end. */
  idleWaiters: (() => void)[];
  /** Set by the steer() method before sending a pause; cleared on agent_end. */
  pendingPause: boolean;
  callbacks: WorkerCallbacks;
}

export class PiRuntime implements WorkerRuntime {
  private readonly opts: PiRuntimeOptions;
  private readonly active = new Map<string, ActiveWorker>();

  constructor(opts: PiRuntimeOptions) {
    this.opts = opts;
  }

  /**
   * Build a fresh pi AgentSession wired to the given SessionManager.
   * Shared between `dispatch` (SessionManager.create) and `resume`
   * (SessionManager.open) so tools, hooks, and event subscription are
   * registered identically for both paths.
   */
  private async buildSession(
    sessionManager: SessionManager,
    workerId: string,
    cwd?: string,
    taskId?: string
  ): Promise<AgentSession> {
    const tools = this.opts.buildTools({ workerId, taskId });
    const sessionCwd = cwd ?? this.opts.cwd;

    // B2 fix: feed Neura's SkillRegistry into pi's resource loader so
    // the agent session sees Neura's loaded skills via `getSkills()`
    // and formats them into its own system prompt. Without this, pi
    // falls back to its default loader which looks under its own
    // conventions (not `.neura/skills`), and the SKILL.md bodies the
    // orchestrator dispatched a worker to execute never reach the
    // worker — it runs as a generic coding agent with no context.
    //
    // We disable pi's own skill discovery via `noSkills: true` and
    // replace the empty base result with the Neura catalog via
    // `skillsOverride`. The override closes over the registry, so a
    // hot-reloaded skill is visible to any session constructed AFTER
    // the reload (existing sessions keep the snapshot they were built
    // with, which is fine — pi reads skills at construction time).
    const resourceLoader = new DefaultResourceLoader({
      cwd: sessionCwd,
      agentDir: this.opts.agentDir,
      noSkills: true,
      skillsOverride: () => ({
        skills: this.opts.skillRegistry
          .listWorkerSkills()
          .filter((s) => !s.disableModelInvocation)
          .map(toPiSkillShape),
        diagnostics: [],
      }),
    });
    await resourceLoader.reload();

    const { session } = await createAgentSession({
      cwd: sessionCwd,
      agentDir: this.opts.agentDir,
      model: this.opts.model,
      thinkingLevel: this.opts.thinkingLevel ?? 'low',
      sessionManager,
      customTools: tools,
      resourceLoader,
      ...(this.opts.authStorage ? { authStorage: this.opts.authStorage } : {}),
    });

    // Phase 6b: the beforeToolCall permission hook that enforced skill
    // `allowed-tools` has been removed. Execution flows through
    // task-driven dispatch and the orchestrator owns the gate (confirmation
    // with the user before dispatching destructive work). Workers rely on
    // filesystem isolation (git worktrees) and prompt-level discipline
    // (the reversibility rule) rather than a per-skill capability filter.

    // Subscribe the voice fanout bridge + our own status tracker. Pi's
    // subscribe emits `AgentSessionEvent` which is a superset of
    // `AgentEvent` — it adds session-level events like queue_update and
    // compaction_start that the voice bridge doesn't need. We filter
    // via `isBridgeEvent` so the bridge only sees the pi-agent-core
    // core events.
    //
    // Pi's subscribe awaits listeners serially; VoiceFanoutBridge.push
    // is synchronous and fire-and-forgets the drain, so we never stall
    // pi's loop even under slow voice bridge conditions.
    session.subscribe((event: AgentSessionEvent) => {
      if (isBridgeEvent(event)) {
        try {
          this.opts.voiceFanoutBridge.push(workerId, event);
        } catch (err) {
          log.error('voice fanout push threw', { workerId, err: String(err) });
        }
        this.handleAgentEvent(workerId, event);
      }
    });

    return session;
  }

  /**
   * Handle pi agent events on the runtime side: flush idle-waiters on
   * agent_end, fire worker callbacks, resolve the handle's `done`
   * promise when the worker reaches a terminal state, etc.
   */
  private handleAgentEvent(workerId: string, event: AgentEvent): void {
    const worker = this.active.get(workerId);
    if (!worker) return;

    if (event.type === 'agent_start') {
      worker.callbacks.onStatusChange?.('running');
    } else if (event.type === 'agent_end') {
      // Flush idle waiters — the pause path uses this to confirm the
      // pause steer landed before transitioning to idle_partial.
      const waiters = worker.idleWaiters.splice(0);
      for (const w of waiters) {
        try {
          w();
        } catch (err) {
          log.warn('idle waiter threw', { workerId, err: String(err) });
        }
      }
    } else if (event.type === 'tool_execution_start') {
      worker.callbacks.onProgress?.(`Calling ${event.toolName}...`);
    } else if (event.type === 'tool_execution_end' && event.isError) {
      worker.callbacks.onProgress?.(`${event.toolName} failed`);
    }
  }

  /**
   * Finalize a worker once its `session.prompt()` call resolves. Applies
   * the stopReason → WorkerStatus mapping and resolves the handle's
   * `done` promise. Called by both `dispatch` and `resume`.
   */
  private finalizeWorker(
    workerId: string,
    stopReason: string | undefined,
    errorMessage?: string
  ): WorkerResult {
    const worker = this.active.get(workerId);
    const finalStatus = this.mapStopReasonToStatus(stopReason, worker?.pendingPause ?? false);
    const result: WorkerResult =
      finalStatus === 'failed' || finalStatus === 'crashed'
        ? {
            status: finalStatus,
            error: { reason: stopReason ?? 'unknown', detail: errorMessage },
          }
        : { status: finalStatus };

    if (worker) {
      worker.callbacks.onStatusChange?.(finalStatus);
      worker.callbacks.onComplete?.(result);
      worker.resolveDone(result);

      // Only evict fully terminal workers from the active map. An
      // idle_partial worker stays in the map so `resume()` can find it
      // by id if the orchestrator chooses to continue without re-
      // reading from disk. Truly paused-for-a-phone-call paths still
      // work: the map just holds the old handle while the session sits
      // idle.
      if (finalStatus !== 'idle_partial') {
        this.active.delete(workerId);
      } else {
        // Clear the pending pause flag now that we've observed the
        // pause-landing agent_end.
        worker.pendingPause = false;
      }
    }
    return result;
  }

  /**
   * Authoritative `stopReason` → `WorkerStatus` mapping. Matches the
   * table in docs/phase6-os-core.md exactly:
   *
   *   "stop"    + pendingPause   → idle_partial
   *   "stop"    + !pendingPause  → completed
   *   "aborted"                  → cancelled
   *   "error"                    → failed
   *   any other / unknown        → failed
   */
  private mapStopReasonToStatus(
    stopReason: string | undefined,
    pendingPause: boolean
  ): WorkerStatus {
    if (stopReason === 'stop') {
      return pendingPause ? 'idle_partial' : 'completed';
    }
    if (stopReason === 'aborted') return 'cancelled';
    if (stopReason === 'error') return 'failed';
    return 'failed';
  }

  /** Read stopReason off the last assistant message in the session state. */
  private extractStopReasonFromSession(session: AgentSession): string | undefined {
    try {
      const messages = (session.state as unknown as { messages?: unknown }).messages;
      if (!Array.isArray(messages)) return undefined;
      for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i] as { role?: unknown; stopReason?: unknown } | undefined;
        if (msg?.role === 'assistant' && typeof msg.stopReason === 'string') {
          return msg.stopReason;
        }
      }
    } catch (err) {
      log.warn('extractStopReasonFromSession failed', { err: String(err) });
    }
    return undefined;
  }

  // ── WorkerRuntime interface ─────────────────────────────────────

  async dispatch(
    task: Parameters<WorkerRuntime['dispatch']>[0],
    callbacks: WorkerCallbacks,
    workerId: string
  ): Promise<WorkerHandle> {
    // `workerId` is caller-provided (the db id from `createWorker`).
    // Keying the active map under this id is essential — it's the same
    // id every downstream control-path caller (steer, abort, waitForIdle,
    // hasWorker, pause_worker, cancel_worker) uses to look this worker
    // back up. If the runtime minted its own id here, the lookup would
    // miss on every one of those methods. See the B1 writeup in the
    // PR review.

    // Use a fresh file-backed SessionManager per dispatch. Writes to
    // `${sessionDir}/<timestamp>_<uuid>.jsonl` which becomes the
    // load-bearing restart-safe identifier for this worker.
    const sessionCwd = task.cwd ?? this.opts.cwd;
    const sessionManager = SessionManager.create(sessionCwd, this.opts.sessionDir);
    const session = await this.buildSession(sessionManager, workerId, sessionCwd, task.taskId);

    let resolveDone!: (result: WorkerResult) => void;
    const done = new Promise<WorkerResult>((resolve) => {
      resolveDone = resolve;
    });

    const worker: ActiveWorker = {
      workerId,
      session,
      skillName: task.skillName,
      resolveDone,
      idleWaiters: [],
      pendingPause: false,
      callbacks,
    };
    this.active.set(workerId, worker);

    // Fire the session.prompt call WITHOUT awaiting. When it resolves we
    // finalize the worker. Errors are caught and surfaced via `failed`.
    session
      .prompt(task.description)
      .then(() => {
        const stopReason = this.extractStopReasonFromSession(session);
        this.finalizeWorker(workerId, stopReason);
      })
      .catch((err: unknown) => {
        log.error('session.prompt threw', { workerId, err: String(err) });
        this.finalizeWorker(workerId, 'error', String(err));
      });

    return {
      workerId,
      sessionId: session.sessionId,
      sessionFile: session.sessionFile,
      done,
    };
  }

  async resume(params: ResumeParams): Promise<WorkerHandle> {
    const { workerId, sessionFile, resumePrompt, callbacks } = params;

    if (!existsSync(sessionFile)) {
      throw new Error(`session file missing: ${sessionFile}`);
    }

    // SessionManager.open() is the real reopen API (not create — Codex
    // caught that in round 2). Verified by Spike #4e.
    const sessionManager = SessionManager.open(sessionFile, this.opts.sessionDir);
    const session = await this.buildSession(sessionManager, workerId);

    let resolveDone!: (result: WorkerResult) => void;
    const done = new Promise<WorkerResult>((resolve) => {
      resolveDone = resolve;
    });

    // Reuse any existing worker state (skillName) if it's still in the
    // active map from a previous in-memory pause. Fresh resume after a
    // core restart: the map is empty and we start with no skillName —
    // callers are expected to pass the skill context through the task
    // row in that case. (Phase 2 step 8 handles the restart-sweep wire-up.)
    const existing = this.active.get(workerId);
    const worker: ActiveWorker = {
      workerId,
      session,
      skillName: existing?.skillName,
      resolveDone,
      idleWaiters: [],
      pendingPause: false,
      callbacks,
    };
    this.active.set(workerId, worker);

    // Resume is a fresh prompt (NOT a steer) on an idle session —
    // verified empirically in Spike #4c / #4e.
    session
      .prompt(resumePrompt)
      .then(() => {
        const stopReason = this.extractStopReasonFromSession(session);
        this.finalizeWorker(workerId, stopReason);
      })
      .catch((err: unknown) => {
        log.error('resume prompt threw', { workerId, err: String(err) });
        this.finalizeWorker(workerId, 'error', String(err));
      });

    return {
      workerId,
      sessionId: session.sessionId,
      sessionFile: session.sessionFile,
      done,
    };
  }

  async steer(workerId: string, message: string): Promise<void> {
    const worker = this.active.get(workerId);
    if (!worker) {
      throw new Error(`steer: worker ${workerId} not found`);
    }
    // Flag pending pause on the bridge so "Done." stays silent on the
    // upcoming agent_end, and on the worker itself so finalizeWorker
    // routes the stopReason to idle_partial instead of completed. The
    // bridge flag is keyed by workerId so parallel workers can pause
    // independently without clobbering each other's completion cues.
    worker.pendingPause = true;
    this.opts.voiceFanoutBridge.setPendingPauseFlag(workerId);
    await worker.session.prompt(message, { streamingBehavior: 'steer' });
  }

  abort(workerId: string): Promise<void> {
    const worker = this.active.get(workerId);
    if (!worker) {
      // Allow idempotent abort on unknown / already-terminal workers.
      return Promise.resolve();
    }
    const agent = worker.session.agent as Agent | undefined;
    // Pi's Agent.abort() is synchronous (void) — it fires the AbortSignal
    // and returns; the agent_end event arrives asynchronously via the
    // event stream. Wrap in Promise.resolve() for the interface.
    if (agent?.abort) {
      agent.abort();
    }
    return Promise.resolve();
  }

  async waitForIdle(workerId: string): Promise<void> {
    const worker = this.active.get(workerId);
    if (!worker) {
      // Already terminal or never existed — resolve immediately.
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      worker.idleWaiters.push(resolve);
    });
  }

  hasWorker(workerId: string): boolean {
    return this.active.has(workerId);
  }

  /**
   * Test helper: returns the count of active workers. Not part of the
   * public `WorkerRuntime` interface — the runtime usage map is implementation
   * detail, exposed here so tests can assert invariants.
   */
  activeCount(): number {
    return this.active.size;
  }
}

/**
 * Compute the default session directory for a given agentDir. Mirrors
 * pi's own default pattern ({agentDir}/sessions).
 */
export function defaultSessionDir(agentDir: string): string {
  return join(agentDir, 'sessions');
}
