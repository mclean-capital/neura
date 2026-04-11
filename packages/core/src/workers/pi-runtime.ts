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
 *   session.agent.beforeToolCall — per-skill allowed-tools enforcement
 *                                   (verified by Spike #4c)
 *   session.subscribe()          — event stream piped to VoiceFanoutBridge
 *                                   (synchronous push, async drain)
 *
 * The runtime is stateful: it tracks active workers in a map keyed by
 * `workerId`. Callers (agent-worker.ts, the run_skill tool) resolve
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
  SessionManager,
  type AgentSession,
  type AgentSessionEvent,
} from '@mariozechner/pi-coding-agent';
import type { Agent, AgentEvent, BeforeToolCallResult } from '@mariozechner/pi-agent-core';
import type { Model } from '@mariozechner/pi-ai';
import type { WorkerCallbacks, WorkerResult, WorkerStatus } from '@neura/types';
import { Logger } from '@neura/utils/logger';
import type { SkillRegistry } from '../skills/skill-registry.js';
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

  /** Factory that builds the full pi tool set for a new worker. */
  buildTools: () => NeuraAgentTool[];

  /** Voice fanout bridge. Shared across workers — one per active voice session. */
  voiceFanoutBridge: VoiceFanoutBridge;

  /**
   * Skill registry for `getAllowedTools()` lookups in `beforeToolCall`.
   * Per-worker active skill name is stored in the worker handle; the
   * permission check resolves it via `registry.getAllowedTools(name)`.
   */
  skillRegistry: SkillRegistry;
}

/**
 * Per-worker state the runtime holds in memory. Separate from the
 * `workers` table row, which lives in PGlite — this struct is the
 * handles and callbacks the runtime needs during execution.
 */
interface ActiveWorker {
  workerId: string;
  session: AgentSession;
  /** Active skill for `beforeToolCall` resolution. */
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
    workerId: string
  ): Promise<AgentSession> {
    const tools = this.opts.buildTools();
    const { session } = await createAgentSession({
      cwd: this.opts.cwd,
      agentDir: this.opts.agentDir,
      model: this.opts.model,
      thinkingLevel: this.opts.thinkingLevel ?? 'low',
      sessionManager,
      customTools: tools,
    });

    // Install the beforeToolCall permission hook. Resolves the currently
    // active skill for this worker and checks against its allowed-tools
    // list. Missing skill (e.g. ad_hoc tasks) means no restriction — the
    // orchestrator decides whether those tasks should exist in the first
    // place; once dispatched, Neura trusts them.
    const agent = session.agent as Agent | undefined;
    if (agent) {
      agent.beforeToolCall = ({ toolCall }): Promise<BeforeToolCallResult | undefined> => {
        const worker = this.active.get(workerId);
        if (!worker?.skillName) return Promise.resolve(undefined);
        const allowed = this.opts.skillRegistry.getAllowedTools(worker.skillName);
        if (!allowed) {
          return Promise.resolve({
            block: true,
            reason: `Skill '${worker.skillName}' is not loaded — cannot authorize tool call.`,
          });
        }
        const toolName = toolCall?.name ?? '';
        if (!allowed.includes(toolName)) {
          log.info('beforeToolCall blocked', { workerId, skillName: worker.skillName, toolName });
          return Promise.resolve({
            block: true,
            reason: `Tool '${toolName}' is not in skill '${worker.skillName}' allowed-tools list.`,
          });
        }
        return Promise.resolve(undefined);
      };
    } else {
      log.warn('session.agent undefined; beforeToolCall not installed', { workerId });
    }

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
          this.opts.voiceFanoutBridge.push(event);
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
    callbacks: WorkerCallbacks
  ): Promise<WorkerHandle> {
    // Generate a workerId locally. The caller (agent-worker.ts) is
    // expected to immediately persist this to the workers table via
    // worker-queries.createWorker() in the same step — Phase 2 step 8
    // wires this up. For tests and direct uses, callers get the id back
    // on the handle and persist as they see fit.
    const workerId = crypto.randomUUID();

    // Use a fresh file-backed SessionManager per dispatch. Writes to
    // `${sessionDir}/<timestamp>_<uuid>.jsonl` which becomes the
    // load-bearing restart-safe identifier for this worker.
    const sessionManager = SessionManager.create(this.opts.cwd, this.opts.sessionDir);
    const session = await this.buildSession(sessionManager, workerId);

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
    // routes the stopReason to idle_partial instead of completed.
    worker.pendingPause = true;
    this.opts.voiceFanoutBridge.setPendingPauseFlag();
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
