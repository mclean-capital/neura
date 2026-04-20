/**
 * Phase 6b — End-to-end simulation.
 *
 * Walks through the full orchestrator ↔ worker protocol in a single test
 * file against real PGlite + real handler wiring, with the pi runtime
 * mocked so we can script worker behavior deterministically. Exercises
 * the bugs the review round found (dispatch race, terminal mirroring,
 * clarification-response persistence, cross-task guard, completion gate)
 * at the integration level rather than per-component.
 *
 * Each scenario is a narrative: user intent → orchestrator tool calls →
 * worker tool calls (driven by the mock runtime firing verb tools in
 * sequence) → assertions on the resulting task / worker / comment state.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
import type { WorkerCallbacks, WorkerResult, WorkerTask } from '@neura/types';
import { runMigrations } from '../stores/migrations.js';
import { createWorkItem, getWorkItem } from '../stores/work-item-queries.js';
import { listComments } from '../stores/task-comment-queries.js';
import { getWorker } from '../stores/worker-queries.js';
import { applyTaskUpdate } from '../tools/task-update-handler.js';
import { buildSystemStateHandler } from '../tools/system-state-handler.js';
import {
  AgentWorker,
  ClarificationBridge,
  buildWorkerProtocolTools,
  type NeuraAgentTool,
} from '../workers/index.js';
import type { WorkerHandle, WorkerRuntime } from '../workers/worker-runtime.js';
import type { TaskToolHandler } from '../tools/index.js';

// ── Fixtures ───────────────────────────────────────────────────────

let db: PGlite;
let worktreeBase: string;

beforeEach(async () => {
  db = await PGlite.create('memory://', { extensions: { vector } });
  await runMigrations(db);
  worktreeBase = mkdtempSync(join(tmpdir(), 'neura-sim-'));
});

afterEach(async () => {
  await db.close();
  if (existsSync(worktreeBase)) {
    rmSync(worktreeBase, { recursive: true, force: true });
  }
});

/**
 * A mock pi runtime that exposes hooks for the test to drive the worker's
 * behavior. `onDispatch` is called once per dispatch; the test supplies
 * what the worker "does" — it receives the verb tools wired at session
 * construction time. Terminal outcome is emitted via `onComplete`.
 */
interface SimulatedWorker {
  tools: NeuraAgentTool[];
  callbacks: WorkerCallbacks;
  workerId: string;
  /** Finish the session with the given result. */
  finish: (result: WorkerResult) => void;
}

type OnDispatch = (worker: SimulatedWorker) => void | Promise<void>;

function makeScriptedRuntime(onDispatch: OnDispatch): {
  runtime: WorkerRuntime;
  buildToolsFactory: (
    build: (ctx: { workerId: string; taskId?: string }) => NeuraAgentTool[]
  ) => void;
} {
  let buildTools: ((ctx: { workerId: string; taskId?: string }) => NeuraAgentTool[]) | null = null;

  const runtime: WorkerRuntime = {
    dispatch: (task: WorkerTask, callbacks: WorkerCallbacks, workerId: string) => {
      let resolveDone!: (r: WorkerResult) => void;
      const done = new Promise<WorkerResult>((resolve) => {
        resolveDone = resolve;
      });
      const handle: WorkerHandle = {
        workerId,
        sessionId: `sess-${workerId}`,
        sessionFile: `/tmp/${workerId}.jsonl`,
        done,
      };
      // Defer the scripted worker run so the dispatcher can finish
      // its bookkeeping (worker_id linkage, etc.) first.
      queueMicrotask(() => {
        const tools = buildTools ? buildTools({ workerId, taskId: task.taskId }) : [];
        const sim: SimulatedWorker = {
          tools,
          callbacks,
          workerId,
          finish: (r) => {
            callbacks.onComplete?.(r);
            resolveDone(r);
          },
        };
        callbacks.onStatusChange?.('running');
        void Promise.resolve(onDispatch(sim)).catch((err: unknown) => {
          const errResult: WorkerResult = {
            status: 'failed',
            error: { reason: 'sim_error', detail: String(err) },
          };
          callbacks.onComplete?.(errResult);
          resolveDone(errResult);
        });
      });
      return Promise.resolve(handle);
    },
    resume: () => Promise.reject(new Error('resume not supported in sim')),
    steer: () => Promise.resolve(),
    abort: () => Promise.resolve(),
    waitForIdle: () => Promise.resolve(),
    hasWorker: () => true,
  };

  return {
    runtime,
    buildToolsFactory: (fn) => {
      buildTools = fn;
    },
  };
}

/** Helper — build an orchestrator-side TaskToolHandler backed by the real invariant layer. */
function buildOrchestratorTaskTools(): TaskToolHandler {
  return {
    createTask: (title, priority, opts) =>
      createWorkItem(db, title, priority, opts).then((id) => id),
    listTasks: () => Promise.resolve([]),
    getTask: (id) => getWorkItem(db, id),
    listTaskComments: (taskId, options) => listComments(db, { taskId, limit: options?.limit }),
    updateTask: async (idOrTitle, payload) => {
      const current = await getWorkItem(db, idOrTitle);
      if (!current) return null;
      return applyTaskUpdate({ db, task: current, payload, actor: 'orchestrator' });
    },
    deleteTask: () => Promise.resolve(false),
  };
}

/** Build a per-worker TaskToolHandler using the real invariant layer. */
function buildWorkerTaskTools(workerId: string): TaskToolHandler {
  return {
    createTask: () => Promise.reject(new Error('not used')),
    listTasks: () => Promise.resolve([]),
    getTask: (id) => getWorkItem(db, id),
    listTaskComments: (taskId, options) => listComments(db, { taskId, limit: options?.limit }),
    updateTask: async (idOrTitle, payload) => {
      const current = await getWorkItem(db, idOrTitle);
      if (!current) return null;
      return applyTaskUpdate({
        db,
        task: current,
        payload,
        actor: `worker:${workerId}`,
      });
    },
    deleteTask: () => Promise.resolve(false),
  };
}

/** Find a tool by name. */
function tool(tools: NeuraAgentTool[], name: string): NeuraAgentTool {
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error(`tool ${name} not found`);
  return t;
}

// ── Scenarios ──────────────────────────────────────────────────────

describe('Phase 6b — happy path: create → dispatch → progress → complete', () => {
  it('end-to-end: orchestrator briefs a task, worker reports progress, then completes', async () => {
    // 1. Orchestrator creates a task.
    const orchTools = buildOrchestratorTaskTools();
    const taskId = await orchTools.createTask('Write hello.txt', 'medium', {
      goal: 'hello.txt exists on the desktop',
      context: {
        acceptanceCriteria: ['file is written', 'content is "hello world"'],
      },
    });

    // 2. Orchestrator dispatches a worker. We script the worker to
    //    post one progress update then complete_task.
    const { runtime, buildToolsFactory } = makeScriptedRuntime(async (w) => {
      await tool(w.tools, 'report_progress').execute('c-1', {
        message: 'starting work',
      });
      await tool(w.tools, 'complete_task').execute('c-2', {
        summary: 'wrote hello world to hello.txt',
      });
      w.finish({ status: 'completed' });
    });
    const bridge = new ClarificationBridge({
      voiceInterjector: { interject: () => Promise.resolve() },
    });
    const agent = new AgentWorker({ db, runtime, worktreeBasePath: worktreeBase });
    buildToolsFactory(({ workerId, taskId: tid }) => {
      return buildWorkerProtocolTools({
        workerId,
        taskId: tid!,
        taskTools: buildWorkerTaskTools(workerId),
        clarificationBridge: bridge,
        db,
      });
    });

    const handle = await agent.dispatchForTask(taskId);
    await handle.done;
    // Let the onComplete → persistTerminalResult chain settle.
    await new Promise((r) => setTimeout(r, 30));

    // 3. Task row is `done`, worker is `completed`, comments tell the story.
    const task = await getWorkItem(db, taskId);
    expect(task?.status).toBe('done');
    expect(task?.workerId).toBe(handle.workerId);

    const worker = await getWorker(db, handle.workerId);
    expect(worker?.status).toBe('completed');

    const comments = await listComments(db, { taskId });
    expect(comments.map((c) => c.type)).toEqual(['progress', 'result']);
    expect(comments[0].author).toBe(`worker:${handle.workerId}`);
  });
});

describe('Phase 6b — clarification round trip unblocks complete_task', () => {
  it('worker asks → user answers via bridge → worker completes without being gated', async () => {
    const orchTools = buildOrchestratorTaskTools();
    const taskId = await orchTools.createTask('Deploy to prod', 'high', {
      goal: 'main branch deployed',
    });

    const bridge = new ClarificationBridge({
      voiceInterjector: { interject: () => Promise.resolve() },
    });

    let answerResolved = false;
    const { runtime, buildToolsFactory } = makeScriptedRuntime(async (w) => {
      // Worker asks a question (blocks).
      const p = tool(w.tools, 'request_clarification').execute('c-1', {
        question: 'main or release?',
      });
      // Give the bridge a tick to register the pending clarification,
      // then simulate the orchestrator handing the user's answer to
      // the bridge.
      await new Promise((r) => setTimeout(r, 5));
      bridge.notifyUserTurn('main');
      await p;
      answerResolved = true;

      // Wait for the orchestrator-side response-comment hook to land
      // so the completion gate sees a resolved request.
      await new Promise((r) => setTimeout(r, 20));

      await tool(w.tools, 'complete_task').execute('c-2', {
        summary: 'deployed main to prod',
      });
      w.finish({ status: 'completed' });
    });
    const agent = new AgentWorker({ db, runtime, worktreeBasePath: worktreeBase });
    buildToolsFactory(({ workerId, taskId: tid }) => {
      return buildWorkerProtocolTools({
        workerId,
        taskId: tid!,
        taskTools: buildWorkerTaskTools(workerId),
        clarificationBridge: bridge,
        db,
      });
    });

    const handle = await agent.dispatchForTask(taskId);
    await handle.done;
    await new Promise((r) => setTimeout(r, 30));

    expect(answerResolved).toBe(true);

    const task = await getWorkItem(db, taskId);
    expect(task?.status).toBe('done');

    // Audit trail: request → response → result. Response carries
    // resolves_comment_id linking back to the request.
    const comments = await listComments(db, { taskId });
    const req = comments.find((c) => c.type === 'clarification_request');
    const resp = comments.find((c) => c.type === 'clarification_response');
    const result = comments.find((c) => c.type === 'result');
    expect(req).toBeDefined();
    expect(resp).toBeDefined();
    expect(result).toBeDefined();
    expect(resp?.metadata).toMatchObject({ resolves_comment_id: req!.id });
    expect(resp?.author).toBe('orchestrator');
    expect(resp?.content).toBe('main');
  });
});

describe('Phase 6b — premature complete_task is rejected', () => {
  it('transitions matrix + completion gate reject complete while a clarification is open; fail_task still works', async () => {
    const orchTools = buildOrchestratorTaskTools();
    const taskId = await orchTools.createTask('Reset prod DB', 'high', {
      goal: 'prod DB reset cleanly',
    });

    let premadeCompleteRejected = false;
    let rejectionMessage: string | undefined;
    let failedStatus: WorkerResult | undefined;
    const { runtime, buildToolsFactory } = makeScriptedRuntime(async (w) => {
      // Ask a clarification but DON'T wait for the answer — the bridge
      // promise sits unresolved and the task stays `awaiting_clarification`.
      // A misbehaving worker decides to complete anyway.
      void tool(w.tools, 'request_clarification').execute('c-1', {
        question: 'which DB?',
      });
      await new Promise((r) => setTimeout(r, 10));

      try {
        await tool(w.tools, 'complete_task').execute('c-2', {
          summary: 'trying to complete with open request',
        });
      } catch (err) {
        // The transition matrix rejects awaiting_clarification → done
        // first (the completion gate would also fire if the worker
        // first returned to in_progress). Either error is an acceptable
        // defense — both are wired in the invariant layer.
        const msg = String(err);
        if (/unresolved request/.exec(msg) || /cannot transition/.exec(msg)) {
          premadeCompleteRejected = true;
          rejectionMessage = msg;
        }
      }

      // Fall back to fail_task, which is always allowed.
      await tool(w.tools, 'fail_task').execute('c-3', {
        reason: 'bailing out',
        reason_code: 'impossible',
      });
      const result: WorkerResult = {
        status: 'failed',
        error: { reason: 'self-reported' },
      };
      failedStatus = result;
      w.finish(result);
    });
    const bridge = new ClarificationBridge({
      voiceInterjector: { interject: () => Promise.resolve() },
    });
    const agent = new AgentWorker({ db, runtime, worktreeBasePath: worktreeBase });
    buildToolsFactory(({ workerId, taskId: tid }) => {
      return buildWorkerProtocolTools({
        workerId,
        taskId: tid!,
        taskTools: buildWorkerTaskTools(workerId),
        clarificationBridge: bridge,
        db,
      });
    });

    const handle = await agent.dispatchForTask(taskId);
    await handle.done;
    await new Promise((r) => setTimeout(r, 30));

    expect(premadeCompleteRejected).toBe(true);
    expect(rejectionMessage).toBeTruthy();
    expect(failedStatus?.status).toBe('failed');

    const task = await getWorkItem(db, taskId);
    expect(task?.status).toBe('failed');
  });
});

describe('Phase 6b — cross-task guard rejects sneaky updates', () => {
  it('a worker cannot post progress to a task it does not own', async () => {
    const orchTools = buildOrchestratorTaskTools();
    // Two tasks, each with a different worker.
    const taskA = await orchTools.createTask('Task A', 'medium', {});
    const taskB = await orchTools.createTask('Task B', 'medium', {});

    const bridge = new ClarificationBridge({
      voiceInterjector: { interject: () => Promise.resolve() },
    });

    let crossTaskRejected = false;
    const { runtime, buildToolsFactory } = makeScriptedRuntime(async (w) => {
      // Worker A tries to post to Task B via its own verb tool —
      // but verb tools close over their own taskId, so this would
      // require building a new tool set. Easier test: use the
      // underlying handler directly as if the worker attempted
      // a forged update.
      const tTools = buildWorkerTaskTools(w.workerId);
      try {
        await tTools.updateTask(taskB, {
          comment: { type: 'progress', content: 'from the wrong worker' },
        });
      } catch (err) {
        if (/cannot update task/.exec(String(err))) {
          crossTaskRejected = true;
        }
      }
      await tool(w.tools, 'complete_task').execute('c-1', {
        summary: 'only on my own task',
      });
      w.finish({ status: 'completed' });
    });
    const agent = new AgentWorker({ db, runtime, worktreeBasePath: worktreeBase });
    buildToolsFactory(({ workerId, taskId: tid }) => {
      return buildWorkerProtocolTools({
        workerId,
        taskId: tid!,
        taskTools: buildWorkerTaskTools(workerId),
        clarificationBridge: bridge,
        db,
      });
    });

    const handleA = await agent.dispatchForTask(taskA);
    await handleA.done;
    await new Promise((r) => setTimeout(r, 30));

    expect(crossTaskRejected).toBe(true);
    // Task A completed on its own ticket.
    const a = await getWorkItem(db, taskA);
    expect(a?.status).toBe('done');
    // Task B was NOT touched.
    const b = await getWorkItem(db, taskB);
    expect(b?.status).toBe('pending');
    const bComments = await listComments(db, { taskId: taskB });
    expect(bComments).toHaveLength(0);
  });
});

describe('Phase 6b — worker crash mirrors terminal status onto the task', () => {
  it('runtime reports crashed → task status becomes failed', async () => {
    const orchTools = buildOrchestratorTaskTools();
    const taskId = await orchTools.createTask('Crash me', 'medium', {});

    const { runtime, buildToolsFactory } = makeScriptedRuntime(async (w) => {
      // Defer the crash past the synchronous window in which
      // dispatchForTask is still running its post-dispatch bookkeeping
      // (session_id/session_file + running status). In production this
      // is never an issue because pi's session.prompt() resolution takes
      // seconds; the mock collapses that to microtasks, so we have to
      // explicitly wait or the `status: 'running'` write would overwrite
      // our crashed status.
      await new Promise((r) => setTimeout(r, 10));
      w.finish({ status: 'crashed', error: { reason: 'simulated' } });
    });
    const bridge = new ClarificationBridge({
      voiceInterjector: { interject: () => Promise.resolve() },
    });
    const agent = new AgentWorker({ db, runtime, worktreeBasePath: worktreeBase });
    buildToolsFactory(({ workerId, taskId: tid }) => {
      return buildWorkerProtocolTools({
        workerId,
        taskId: tid!,
        taskTools: buildWorkerTaskTools(workerId),
        clarificationBridge: bridge,
        db,
      });
    });

    const handle = await agent.dispatchForTask(taskId);
    await handle.done;
    await new Promise((r) => setTimeout(r, 30));

    const task = await getWorkItem(db, taskId);
    expect(task?.status).toBe('failed');
    const worker = await getWorker(db, handle.workerId);
    expect(worker?.status).toBe('crashed');

    // A system-authored error comment should have been posted so
    // `get_task` surfaces the reason. Without this the user sees
    // "failed" with no explanation and asks "why?" with nothing to
    // show them.
    const comments = await listComments(db, { taskId, type: 'error' });
    const systemErr = comments.find((c) => c.author === 'system');
    expect(systemErr).toBeTruthy();
    expect(systemErr?.content).toContain('simulated');
    expect(systemErr?.metadata).toMatchObject({
      workerId: handle.workerId,
      workerStatus: 'crashed',
    });
  });

  it('truncates huge error detail so the insert stays under the 32KB cap', async () => {
    const orchTools = buildOrchestratorTaskTools();
    const taskId = await orchTools.createTask('Big error', 'medium', {});

    // 40 KB stack trace — over insertComment's 32 KB content cap.
    // Without truncation, insertComment throws and the error comment
    // is lost, dropping us back to the silent-failure bug.
    const hugeDetail = 'x'.repeat(40_000);

    const { runtime, buildToolsFactory } = makeScriptedRuntime(async (w) => {
      await new Promise((r) => setTimeout(r, 10));
      w.finish({
        status: 'failed',
        error: { reason: 'hard_error', detail: hugeDetail },
      });
    });
    const bridge = new ClarificationBridge({
      voiceInterjector: { interject: () => Promise.resolve() },
    });
    const agent = new AgentWorker({ db, runtime, worktreeBasePath: worktreeBase });
    buildToolsFactory(({ workerId, taskId: tid }) => {
      return buildWorkerProtocolTools({
        workerId,
        taskId: tid!,
        taskTools: buildWorkerTaskTools(workerId),
        clarificationBridge: bridge,
        db,
      });
    });

    const handle = await agent.dispatchForTask(taskId);
    await handle.done;
    await new Promise((r) => setTimeout(r, 30));

    const comments = await listComments(db, { taskId, type: 'error' });
    const systemErr = comments.find((c) => c.author === 'system');
    expect(systemErr).toBeTruthy();
    // Reason is preserved; detail is truncated but still present.
    expect(systemErr?.content).toMatch(/^hard_error: x+$/);
    // Content size must be under the DB cap.
    expect(Buffer.byteLength(systemErr?.content ?? '', 'utf8')).toBeLessThan(32 * 1024);
  });
});

describe('Phase 6b — redispatch guards', () => {
  it('rejects a second dispatch_worker on a task that is already done', async () => {
    const orchTools = buildOrchestratorTaskTools();
    const taskId = await orchTools.createTask('One shot', 'medium', {});

    const { runtime, buildToolsFactory } = makeScriptedRuntime(async (w) => {
      await tool(w.tools, 'complete_task').execute('c-1', { summary: 'done' });
      w.finish({ status: 'completed' });
    });
    const bridge = new ClarificationBridge({
      voiceInterjector: { interject: () => Promise.resolve() },
    });
    const agent = new AgentWorker({ db, runtime, worktreeBasePath: worktreeBase });
    buildToolsFactory(({ workerId, taskId: tid }) => {
      return buildWorkerProtocolTools({
        workerId,
        taskId: tid!,
        taskTools: buildWorkerTaskTools(workerId),
        clarificationBridge: bridge,
        db,
      });
    });

    const handle = await agent.dispatchForTask(taskId);
    await handle.done;
    await new Promise((r) => setTimeout(r, 30));

    await expect(agent.dispatchForTask(taskId)).rejects.toThrow(/terminal/);
  });
});

describe('Phase 6b — get_system_state surfaces what needs attention', () => {
  it('reports attentionRequired when a worker is waiting on a clarification', async () => {
    const orchTools = buildOrchestratorTaskTools();
    const taskId = await orchTools.createTask('Needs input', 'high', {
      goal: 'worker gets a question answered',
    });

    const bridge = new ClarificationBridge({
      voiceInterjector: { interject: () => Promise.resolve() },
    });

    let readySignal!: () => void;
    const readyForSnapshot = new Promise<void>((r) => {
      readySignal = r;
    });

    const { runtime, buildToolsFactory } = makeScriptedRuntime(async (w) => {
      // Block forever on a clarification; we never answer. Snapshot
      // is taken while the worker is waiting.
      const p = tool(w.tools, 'request_clarification').execute('c-1', {
        question: 'which one?',
        urgency: 'high',
      });
      await new Promise((r) => setTimeout(r, 5));
      readySignal();
      // Then have the test unblock us by calling notifyUserTurn.
      await p;
      await new Promise((r) => setTimeout(r, 10));
      w.finish({ status: 'completed' });
    });
    const agent = new AgentWorker({ db, runtime, worktreeBasePath: worktreeBase });
    buildToolsFactory(({ workerId, taskId: tid }) => {
      return buildWorkerProtocolTools({
        workerId,
        taskId: tid!,
        taskTools: buildWorkerTaskTools(workerId),
        clarificationBridge: bridge,
        db,
      });
    });
    const systemState = buildSystemStateHandler({
      db,
      store: {
        // Satisfy DataStore enough for the handler's reads — it uses
        // the raw db for most queries. The two store methods the
        // handler touches via interface are not exercised in this
        // test, so a narrow cast is safe.
      } as unknown as Parameters<typeof buildSystemStateHandler>[0]['store'],
    });

    const handle = await agent.dispatchForTask(taskId);
    await readyForSnapshot;

    // Snapshot while the worker is blocked — should surface the task
    // in attentionRequired with the urgency we posted.
    const snap = await systemState.getSystemState();
    expect(snap.activeWorkers).toBeGreaterThanOrEqual(1);
    const attention = snap.attentionRequired.find((t) => t.id === taskId);
    expect(attention).toBeDefined();
    expect(attention?.status).toBe('awaiting_clarification');
    expect(attention?.urgency).toBe('high');

    // Now let the worker finish so we don't leak a pending Promise.
    bridge.notifyUserTurn('option A');
    await handle.done;
    await new Promise((r) => setTimeout(r, 30));
  });
});
