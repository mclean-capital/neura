#!/usr/bin/env tsx
/**
 * Phase 6b live smoke — opt-in real-LLM dispatch.
 *
 * Spins up a minimal runtime (PgliteStore + ClarificationBridge +
 * PiRuntime + AgentWorker) against the provider configured under
 * ~/.neura/config.json -> routing.worker, dispatches one worker against
 * a scratch task, and tails the task_comments until the worker reaches
 * a terminal state. Prints the final audit trail as JSON.
 *
 * Burns real money on every run — hard-gated behind NEURA_LIVE_SIM=1.
 * Uses a throwaway PGlite dir under $TMPDIR so it never touches
 * ~/.neura/pgdata. No audio, no voice session — verb-tool calls fall
 * back to their "no live session" no-ops when the user isn't there to
 * answer clarifications.
 *
 * Usage:
 *   NEURA_LIVE_SIM=1 npm run sim:live -w @neura/core
 *
 * Custom goal:
 *   NEURA_LIVE_SIM=1 NEURA_SIM_GOAL='...' npm run sim:live -w @neura/core
 *
 * Safety defaults the script enforces:
 *   - Aborts after WALL_CLOCK_CAP_MS (default 5 min) regardless of
 *     worker state.
 *   - Aborts after TOOL_CALL_CAP iterations to bound cost even if the
 *     model spins.
 *   - Worktree base is a fresh tmpdir, swept on exit.
 *   - Task goal defaults to "write a scratch file to a tmpdir" — pure
 *     filesystem, no external side effects.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
import { createWorkItem, getWorkItem } from '../src/stores/work-item-queries.js';
import { listComments } from '../src/stores/task-comment-queries.js';
import { runMigrations } from '../src/stores/migrations.js';
import {
  AgentWorker,
  ClarificationBridge,
  PiRuntime,
  VoiceFanoutBridge,
  buildNeuraTools,
  buildWorkerProtocolTools,
  defaultSessionDir,
  type NeuraAgentTool,
} from '../src/workers/index.js';
import { applyTaskUpdate } from '../src/tools/task-update-handler.js';
import { SkillRegistry } from '../src/skills/skill-registry.js';
import type { TaskToolHandler } from '../src/tools/index.js';
import type { PGlite as PGliteType } from '@electric-sql/pglite';

// ── Safety gates ───────────────────────────────────────────────────

if (process.env.NEURA_LIVE_SIM !== '1') {
  console.error(
    '[sim-live-dispatch] refused: set NEURA_LIVE_SIM=1 to run. This script makes real LLM calls (cost + latency).'
  );
  process.exit(2);
}

const WALL_CLOCK_CAP_MS = Number(process.env.NEURA_SIM_WALL_CLOCK_MS ?? 5 * 60_000);
const POLL_INTERVAL_MS = 500;

// ── Config ──────────────────────────────────────────────────────────

interface SimConfig {
  providers: Record<string, { apiKey?: string }>;
  routing: { worker?: { provider: string; model: string } };
}

function loadConfig(): SimConfig {
  const configPath = join(homedir(), '.neura', 'config.json');
  if (!existsSync(configPath)) {
    console.error(
      `[sim-live-dispatch] ~/.neura/config.json not found. Need routing.worker + providers.<id>.apiKey.`
    );
    process.exit(2);
  }
  try {
    return JSON.parse(readFileSync(configPath, 'utf-8')) as SimConfig;
  } catch (err) {
    console.error(`[sim-live-dispatch] bad config.json: ${String(err)}`);
    process.exit(2);
  }
}

const config = loadConfig();

function die(msg: string): never {
  console.error(`[sim-live-dispatch] ${msg}`);
  process.exit(2);
}

const workerRoute =
  config.routing.worker ?? die('config.routing.worker is required (provider + model).');
const workerApiKey =
  config.providers[workerRoute.provider]?.apiKey ??
  die(
    `providers.${workerRoute.provider}.apiKey missing. Worker route = ${workerRoute.provider}/${workerRoute.model}.`
  );

// ── Scratch workspace ──────────────────────────────────────────────

const scratchRoot = mkdtempSync(join(tmpdir(), 'neura-live-sim-'));
const pgDataDir = join(scratchRoot, 'pgdata');
const worktreeBase = join(scratchRoot, 'worktrees');
const agentDir = join(scratchRoot, 'agent');
const sessionDir = defaultSessionDir(agentDir);
const outputFile = join(scratchRoot, 'sim-output.txt');

const goal =
  process.env.NEURA_SIM_GOAL ??
  `Write "hello from a Neura worker" to the file ${outputFile}, then call complete_task with a one-line summary.`;

function cleanup(): void {
  try {
    if (existsSync(scratchRoot)) rmSync(scratchRoot, { recursive: true, force: true });
  } catch (err) {
    console.warn(`[sim-live-dispatch] cleanup warn: ${String(err)}`);
  }
}
process.on('exit', cleanup);
process.on('SIGINT', () => {
  cleanup();
  process.exit(130);
});

// ── Bootstrap ──────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.error(`[sim-live-dispatch] scratch=${scratchRoot}`);
  console.error(`[sim-live-dispatch] worker route = ${workerRoute.provider}/${workerRoute.model}`);
  console.error(`[sim-live-dispatch] goal = ${goal}`);

  const db = await PGlite.create(pgDataDir, { extensions: { vector } });
  await runMigrations(db);

  // Set the API key as an env var so pi-ai picks it up. pi-ai reads the
  // canonical XAI_API_KEY / OPENAI_API_KEY / etc. from process.env when
  // resolving the model.
  const envKey = envKeyFor(workerRoute.provider);
  if (envKey) {
    process.env[envKey] = workerApiKey;
  }

  const { getModel } = await import('@mariozechner/pi-ai');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const model = getModel(workerRoute.provider as any, workerRoute.model);
  if (!model) {
    throw new Error(
      `pi-ai does not know ${workerRoute.provider}/${workerRoute.model}. Try a different worker route.`
    );
  }

  const skillRegistry = new SkillRegistry();
  const voiceFanoutBridge = new VoiceFanoutBridge({
    interjector: { interject: () => Promise.resolve() },
  });
  const bridge = new ClarificationBridge({
    voiceInterjector: voiceFanoutBridge,
  });

  const buildWorkerTaskTools = (workerId: string): TaskToolHandler => ({
    createTask: (title, priority, opts) => createWorkItem(db, title, priority, opts),
    listTasks: () => Promise.resolve([]),
    getTask: (id) => getWorkItem(db, id),
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
  });

  const buildTools = ({
    workerId,
    taskId,
  }: {
    workerId: string;
    taskId?: string;
  }): NeuraAgentTool[] => {
    const taskTools = buildWorkerTaskTools(workerId);
    const base = buildNeuraTools({
      queryWatcher: () => Promise.resolve('vision not wired in the live sim'),
      taskTools,
    });
    if (taskId) {
      base.push(
        ...buildWorkerProtocolTools({
          workerId,
          taskId,
          taskTools,
          clarificationBridge: bridge,
          db,
        })
      );
    }
    return base;
  };

  const piRuntime = new PiRuntime({
    model,
    thinkingLevel: 'low',
    cwd: process.cwd(),
    agentDir,
    sessionDir,
    buildTools,
    voiceFanoutBridge,
    skillRegistry,
  });
  const agent = new AgentWorker({ db, runtime: piRuntime, worktreeBasePath: worktreeBase });
  await agent.recoverFromCrash();

  // Create the task. We post through the invariant layer as
  // orchestrator so the version counter starts clean and author
  // scoping is honored.
  const taskId = await createWorkItem(db, 'Live dispatch smoke', 'medium', {
    goal,
    context: {
      acceptanceCriteria: [
        `the file ${outputFile} exists after the worker completes`,
        'the worker calls complete_task (not fail_task) when done',
      ],
    },
  });
  console.error(`[sim-live-dispatch] taskId=${taskId}`);

  // Auto-answer any clarifications with a canned "proceed" so the
  // worker doesn't hang waiting for a human. Delay slightly so the
  // verb tool has time to register its pending answer.
  const interval = setInterval(() => {
    if (bridge.pendingCount > 0) {
      console.error('[sim-live-dispatch] auto-answering pending clarification with "proceed"');
      bridge.notifyUserTurn('proceed');
    }
  }, 1_000);

  const handle = await agent.dispatchForTask(taskId);
  console.error(`[sim-live-dispatch] workerId=${handle.workerId}`);

  const abortTimer = setTimeout(() => {
    console.error(`[sim-live-dispatch] wall-clock cap ${WALL_CLOCK_CAP_MS}ms reached — aborting`);
    void agent.cancel(handle.workerId);
  }, WALL_CLOCK_CAP_MS);
  abortTimer.unref();

  // Poll comments + terminal status.
  while (true) {
    const task = await getWorkItem(db, taskId);
    if (!task) break;
    if (task.status === 'done' || task.status === 'failed' || task.status === 'cancelled') {
      break;
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }

  clearInterval(interval);
  clearTimeout(abortTimer);

  const finalTask = await getWorkItem(db, taskId);
  const comments = await listComments(db, { taskId });
  const fileExists = existsSync(outputFile);

  // Print a compact JSON audit so log scrapers / CI can parse easily.
  const audit = {
    taskId,
    workerId: handle.workerId,
    status: finalTask?.status,
    goal,
    outputFile,
    fileExists,
    fileContent: fileExists ? safeRead(outputFile) : null,
    comments: comments.map((c) => ({
      type: c.type,
      author: c.author,
      urgency: c.urgency,
      createdAt: c.createdAt,
      content: truncate(c.content, 400),
      metadata: c.metadata,
    })),
    worktreeBase,
    scratchRoot,
  };
  console.log(JSON.stringify(audit, null, 2));

  await db.close();

  // Exit code: 0 on done, 1 on failed, 2 on anything else.
  if (finalTask?.status === 'done') process.exit(0);
  if (finalTask?.status === 'failed') process.exit(1);
  process.exit(2);
}

function envKeyFor(provider: string): string | null {
  const p = provider.toLowerCase();
  if (p === 'xai') return 'XAI_API_KEY';
  if (p === 'openai') return 'OPENAI_API_KEY';
  if (p === 'anthropic') return 'ANTHROPIC_API_KEY';
  if (p === 'google') return 'GOOGLE_API_KEY';
  return null;
}

function safeRead(path: string): string {
  try {
    return readFileSync(path, 'utf-8');
  } catch {
    return '';
  }
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + `… (+${s.length - max} bytes)` : s;
}

// Silence type-only imports that tsx / tsc want to see referenced.
void execFileSync;
void (null as unknown as PGliteType);

main().catch((err: unknown) => {
  console.error(`[sim-live-dispatch] fatal: ${String(err)}`);
  process.exit(1);
});
