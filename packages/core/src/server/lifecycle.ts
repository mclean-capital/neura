import { existsSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { WebSocket } from 'ws';
import type { DataStore, NeuraSkill, ServerMessage, VoiceProvider } from '@neura/types';
import { Logger } from '@neura/utils/logger';
import { loadConfig } from '../config/index.js';
import { ProviderRegistry } from '../registry/index.js';
import { MemoryManager } from '../memory/index.js';
import { BackupService } from '../memory/index.js';
import type { PresenceManager } from '../presence/index.js';
import { DiscoveryLoop } from '../discovery/index.js';
import { SkillRegistry } from '../skills/skill-registry.js';
import { SkillWatcher } from '../skills/skill-watcher.js';
import {
  AgentWorker,
  ClarificationBridge,
  PiRuntime,
  VoiceFanoutBridge,
  buildClarificationTool,
  buildNeuraTools,
  buildWorkerProtocolTools,
  defaultSessionDir,
  type NeuraAgentTool,
} from '../workers/index.js';
import { AuthStorage } from '@mariozechner/pi-coding-agent';
import { seedAuthStorageFromConfig } from '../workers/auth-bridge.js';
import type {
  MemoryToolHandler,
  SkillToolHandler,
  SystemStateHandler,
  TaskToolHandler,
  WorkerControlHandler,
  WorkerDispatchHandler,
} from '../tools/index.js';
import { applyTaskUpdate, buildSystemStateHandler } from '../tools/index.js';
import { listComments } from '../stores/task-comment-queries.js';
import type { Server } from 'http';
import type { WebSocketServer } from 'ws';

const log = new Logger('server');

export interface CoreServices {
  config: ReturnType<typeof loadConfig>;
  registry: ProviderRegistry;
  store: DataStore | null;
  memoryManager: MemoryManager | null;
  backupService: BackupService | null;
  discoveryLoop: DiscoveryLoop | null;
  connectedClients: Map<
    WebSocket,
    {
      send: (msg: ServerMessage) => void;
      presence: PresenceManager;
      getSession: () => VoiceProvider | null;
    }
  >;
  // Phase 6: skill subsystem + worker runtime + voice fanout bridge.
  // All four are null when pi-coding-agent isn't available (missing API
  // key, missing store, etc.) — the skill tools fall back to an
  // unavailable error in that case.
  skillRegistry: SkillRegistry | null;
  skillWatcher: SkillWatcher | null;
  agentWorker: AgentWorker | null;
  voiceFanoutBridge: VoiceFanoutBridge | null;
  clarificationBridge: ClarificationBridge | null;
  skillToolHandler: SkillToolHandler | null;
  workerControlHandler: WorkerControlHandler | null;
  systemStateHandler: SystemStateHandler | null;
  workerDispatchHandler: WorkerDispatchHandler | null;
  version: string;
  pendingCleanups: Set<Promise<void>>;
}

function resolveVersion(neuraHome: string): string {
  // 1. Explicit env var override (used by dev, Docker)
  if (process.env.NEURA_VERSION) return process.env.NEURA_VERSION;

  // 2. version.txt next to the running bundle. Since v1.11.0 the core ships
  //    inside the CLI npm package at <cli-pkg>/core/server.bundled.mjs, and
  //    tools/bundle-core-into-cli.mjs writes <cli-pkg>/core/version.txt.
  //    import.meta.url resolves to that same directory at runtime.
  try {
    const bundleDir = dirname(fileURLToPath(import.meta.url));
    const bundleVersionPath = join(bundleDir, 'version.txt');
    if (existsSync(bundleVersionPath)) {
      return readFileSync(bundleVersionPath, 'utf-8').trim();
    }
  } catch {
    // Fall through to legacy path
  }

  // 3. Legacy location (pre-1.11.0): ~/.neura/core/version.txt from the
  //    downloaded tarball. Kept for backwards compatibility.
  try {
    const versionPath = join(neuraHome, 'core', 'version.txt');
    return readFileSync(versionPath, 'utf-8').trim();
  } catch {
    return '0.0.0-dev';
  }
}

export async function initServices(): Promise<CoreServices> {
  const config = loadConfig();
  const version = resolveVersion(config.neuraHome);

  // Create provider registry from v3 config
  const registry = new ProviderRegistry(config);

  // Windows: write our PID to `$NEURA_HOME/neura-core.pid` so the CLI's
  // Windows service manager (which uses a dumb cmd-shim launcher rather
  // than a real SCM service) can find us for `neura status` and
  // `neura stop`. Capturing the current process's PID from inside cmd.exe
  // is genuinely painful — having the core itself write the pid is both
  // simpler and more reliable. Remove on clean exit.
  //
  // macOS and Linux already have native service managers (launchd /
  // systemd) that track PIDs for us, so we skip this on those platforms.
  if (process.platform === 'win32') {
    const corePidFile = join(config.neuraHome, 'neura-core.pid');
    try {
      writeFileSync(corePidFile, String(process.pid));
      const cleanup = (): void => {
        try {
          unlinkSync(corePidFile);
        } catch {
          // Already removed; fine.
        }
      };
      // The 'exit' handler fires on any terminal path, so pid file
      // cleanup is guaranteed to run on normal shutdown.
      process.on('exit', cleanup);
      // Also clean up the pid file on SIGINT/SIGTERM. CRITICAL: we do
      // NOT call process.exit() from these handlers — `server.ts` also
      // registers SIGINT/SIGTERM listeners via `doShutdown()` that close
      // the store, drain websockets, and run a final memory backup.
      // Node runs listeners in registration order; since `initServices`
      // is called before `server.ts` attaches its listeners, if we
      // exited here the downstream graceful-shutdown handler would
      // never run and we'd leave PGlite dirty / the backup stale.
      // Just cleanup the pid file and let the next listener proceed.
      process.on('SIGINT', cleanup);
      process.on('SIGTERM', cleanup);
    } catch (err) {
      log.warn('failed to write neura-core.pid', { err: String(err) });
    }
  }

  // Initialize data store if DB path is available (optional — skip persistence if not configured).
  // PGlite (WASM Postgres) can corrupt on dirty shutdown (force kill, crash). If the database
  // fails to open, delete the data directory and retry with a fresh database, then restore
  // memories from the periodic backup file.
  let store: DataStore | null = null;
  const backupPath = join(config.neuraHome, 'memory-backup.json');

  if (config.pgDataPath) {
    // Clean stale postmaster.pid from a previous dirty shutdown
    const pidPath = join(config.pgDataPath, 'postmaster.pid');
    if (existsSync(pidPath)) {
      log.warn('removing stale postmaster.pid');
      unlinkSync(pidPath);
    }

    try {
      const { PgliteStore } = await import('../stores/index.js');
      const embDims = config.routing.embedding?.dimensions;
      store = await PgliteStore.create(config.pgDataPath, embDims);
      log.info('database initialized', { path: config.pgDataPath, embeddingDimensions: embDims });
    } catch (err) {
      log.warn('database corrupt or failed to open, resetting', { err: String(err) });
      try {
        rmSync(config.pgDataPath, { recursive: true, force: true });
        const { PgliteStore } = await import('../stores/index.js');
        const embDims = config.routing.embedding?.dimensions;
        store = await PgliteStore.create(config.pgDataPath, embDims);
        log.info('database recreated after reset', { path: config.pgDataPath });

        // Auto-restore memories from backup after corruption recovery
        if (existsSync(backupPath)) {
          const bs = new BackupService({ store, backupPath });
          const result = await bs.restore();
          if (result) {
            log.info('memories restored from backup after corruption', result);
          }
        }
      } catch (retryErr) {
        log.warn('database unavailable after reset, persistence disabled', {
          err: String(retryErr),
        });
      }
    }
  }

  // Initialize memory manager if store and Google API key are available
  let memoryManager: MemoryManager | null = null;
  let backupService: BackupService | null = null;

  const textAdapter = registry.getTextAdapter();
  const embeddingAdapter = registry.getEmbeddingAdapter();
  if (store && textAdapter && embeddingAdapter) {
    try {
      memoryManager = new MemoryManager({
        store,
        textAdapter,
        embeddingAdapter,
        onExtractionComplete: () => backupService?.backup() ?? Promise.resolve(),
        retrievalStrategy: config.retrievalStrategy,
        assistantName: config.assistantName,
      });
      log.info('memory manager initialized');
    } catch (err) {
      log.warn('memory manager disabled — adapter error', {
        err: String(err),
      });
    }
  } else if (store) {
    log.info('memory manager disabled — text or embedding route not configured');
  }

  // Start periodic memory backup
  if (store) {
    backupService = new BackupService({ store, backupPath });
    backupService.checkStaleness();
    backupService.start();
  }

  // Connected clients registry — discovery loop uses this to deliver notifications
  const connectedClients = new Map<
    WebSocket,
    {
      send: (msg: ServerMessage) => void;
      presence: PresenceManager;
      getSession: () => VoiceProvider | null;
    }
  >();

  // Discovery loop — reviews open tasks, checks deadlines, notifies clients
  let discoveryLoop: DiscoveryLoop | null = null;
  if (store && textAdapter) {
    try {
      discoveryLoop = new DiscoveryLoop({
        store,
        textAdapter,
        onNotifications: (summary, items) => {
          for (const [, client] of connectedClients) {
            if (client.presence.state === 'active') {
              const session = client.getSession();
              if (session) {
                session.sendText(`Task reminder: ${summary}`);
              }
            } else if (client.presence.state === 'passive') {
              client.send({ type: 'discoveryNotification', summary, items });
            }
          }
        },
      });
      discoveryLoop.start();
    } catch (err) {
      log.warn('discovery loop disabled — text adapter error', {
        err: String(err),
      });
    }
  } else if (store) {
    log.info('discovery loop disabled — text route not configured');
  }

  const pendingCleanups = new Set<Promise<void>>();

  // ── Phase 6: skill subsystem + worker runtime ──────────────────────
  //
  // Only initialize if we have both a store (to persist workers table)
  // and an xAI API key (pi-coding-agent needs a model). The skill
  // registry could load without the runtime, but tying them together
  // matches the all-or-nothing nature of Phase 6 — either workers are
  // available and skills can run, or neither is.
  let skillRegistry: SkillRegistry | null = null;
  let skillWatcher: SkillWatcher | null = null;
  let agentWorker: AgentWorker | null = null;
  let voiceFanoutBridge: VoiceFanoutBridge | null = null;
  let clarificationBridge: ClarificationBridge | null = null;
  let skillToolHandler: SkillToolHandler | null = null;
  let workerControlHandler: WorkerControlHandler | null = null;
  let systemStateHandler: SystemStateHandler | null = null;
  let workerDispatchHandler: WorkerDispatchHandler | null = null;

  const workerRoute = config.routing.worker;
  const workerProviderAvailable = workerRoute && !!config.providers[workerRoute.provider]?.apiKey;
  if (store && workerProviderAvailable) {
    try {
      const agentDir = join(config.neuraHome, 'agent');
      const sessionDir = defaultSessionDir(agentDir);
      const globalSkillsDir = join(homedir(), '.neura', 'skills');

      // Resolve the skills directory that ships with the install. When
      // the CLI bundle runs, this file lives at
      // `<pkg>/core/server.bundled.mjs`, and `tools/bundle-core-into-cli.mjs`
      // copies `.neura/skills/` to a sibling `<pkg>/skills/`. In dev
      // (source tree) the path resolves to `packages/core/../../.neura/skills`
      // which is the repo's own `.neura/skills/` — it's the same as
      // repo-local but harmless (pi dedupes by skill name).
      const bundleDir = dirname(fileURLToPath(import.meta.url));
      const bundledSkillsDir = join(bundleDir, '..', 'skills');

      // Skill registry is populated by the watcher's initial load.
      skillRegistry = new SkillRegistry();
      skillWatcher = new SkillWatcher({
        registry: skillRegistry,
        cwd: process.cwd(),
        globalSkillsDir,
        bundledSkillsDir,
      });
      await skillWatcher.start();
      log.info('skill registry loaded', {
        count: skillRegistry.size,
        bundledSkillsDir,
      });

      // Voice fanout bridge. Interjector is attached per-client via
      // bridge.setInterjector() from websocket.ts on connect/disconnect.
      // Starts with a no-op so ambient progress events during worker
      // startup don't fail.
      voiceFanoutBridge = new VoiceFanoutBridge({
        interjector: { interject: () => Promise.resolve() },
      });

      // Worker-side tool context. Workers get memory + task tools
      // (persistent services that live longer than any voice session).
      // queryWatcher delegates through services to whatever client is
      // currently sharing camera/screen; if no client is active, it
      // returns a clear error so the worker can react gracefully.
      const workerMemoryTools: MemoryToolHandler | undefined = memoryManager
        ? {
            storeFact: (content, category, tags, sessionId) =>
              memoryManager.storeFact(content, category, tags, sessionId),
            recall: (query, limit) => memoryManager.recall(query, limit),
            storePreference: (preference, category, sessionId) =>
              memoryManager.storePreference(preference, category, sessionId),
            invalidateFact: (query) => memoryManager.invalidateFact(query),
            getTimeline: (daysBack, entityFilter) =>
              memoryManager.getTimeline(daysBack, entityFilter),
            getMemoryStats: () => memoryManager.getMemoryStats(),
          }
        : undefined;

      // Hoist the raw PGlite handle once so buildWorkerTaskTools AND
      // buildTools (below) can share it — buildTools needs it to pass
      // into buildWorkerProtocolTools for the orchestrator-side
      // response-comment persistence hook.
      const rawDb = store.getRawDb?.() as import('@electric-sql/pglite').PGlite | undefined;
      if (!rawDb) {
        throw new Error(
          'store does not expose a raw PGlite handle (required for Phase 6 worker runtime)'
        );
      }

      // Worker-side task tools factory. Every worker gets its own handler
      // with `actor: worker:<workerId>` baked in — that's how the shared
      // `applyTaskUpdate` enforces author scoping, cross-task writes, and
      // the transition matrix. Workers can create sub-tasks, read task
      // state, and update their own task (post comments + status
      // transitions via the worker protocol). Deletion is
      // orchestrator-only — stub-refused for workers.
      const buildWorkerTaskTools = (workerId: string): TaskToolHandler => {
        return {
          createTask: (title, priority, opts) => store.createWorkItem(title, priority, opts),
          listTasks: async (filter) => {
            const limit = filter?.limit ?? 100;

            if (
              !filter ||
              (!filter.status && !filter.needsAttention && !filter.source && !filter.since)
            ) {
              return store.getOpenWorkItems(limit);
            }

            const hasAllInArrayOrScalar =
              filter.status === 'all' ||
              (Array.isArray(filter.status) && filter.status.includes('all' as never));

            let candidates: Awaited<ReturnType<typeof store.getWorkItems>>;
            if (hasAllInArrayOrScalar) {
              candidates = await store.getWorkItems({ limit: 500 });
            } else if (Array.isArray(filter.status)) {
              const all = await store.getWorkItems({ limit: 500 });
              const wanted = new Set(filter.status);
              candidates = all.filter((t) => wanted.has(t.status));
            } else if (typeof filter.status === 'string') {
              candidates = await store.getWorkItems({ status: filter.status, limit: 500 });
            } else {
              candidates = await store.getOpenWorkItems(500);
            }

            if (filter.source) {
              candidates = candidates.filter((t) => t.source === filter.source);
            }
            if (filter.since) {
              const sinceMs = Date.parse(filter.since);
              if (!Number.isNaN(sinceMs)) {
                candidates = candidates.filter((t) => Date.parse(t.updatedAt) > sinceMs);
              }
            }

            return candidates.slice(0, limit);
          },
          getTask: (idOrTitle) => store.getWorkItem(idOrTitle),
          listTaskComments: async (taskId, options) => {
            return listComments(rawDb, {
              taskId,
              limit: options?.limit,
              order: options?.order,
              excludeTypes: options?.excludeTypes,
            });
          },
          updateTask: async (idOrTitle, payload) => {
            const current = await store.getWorkItem(idOrTitle);
            if (!current) return null;
            return applyTaskUpdate({
              db: rawDb,
              task: current,
              payload,
              actor: `worker:${workerId}`,
            });
          },
          deleteTask: (idOrTitle) => {
            log.warn('worker tried deleteTask (not supported for workers)', { idOrTitle });
            return Promise.resolve(false);
          },
        };
      };

      // Clarification bridge — sits between running workers (via the
      // request_clarification pi custom tool) and the voice session's
      // next-user-turn events. Built BEFORE the pi runtime so the
      // buildTools factory can close over it.
      //
      // onBlock/onUnblock close over the outer `agentWorker` binding
      // so they read its current value at call time — agentWorker is
      // assigned later in this block after the runtime is constructed.
      // This is the C2 fix: without these callbacks, workers waiting
      // on a user clarification stayed marked `running` in the db,
      // and list_active_workers / orchestrator-prompt logic couldn't
      // distinguish "answer the clarification" from "resume a paused
      // worker". onPromotion still unwired — promotion dispatch lands
      // as a separate polish item.
      clarificationBridge = new ClarificationBridge({
        voiceInterjector: voiceFanoutBridge,
        onBlock: async (workerId) => {
          try {
            await agentWorker?.setStatus(workerId, 'blocked_clarifying');
          } catch (err) {
            log.warn('onBlock setStatus failed', { workerId, err: String(err) });
          }
        },
        onUnblock: async (workerId) => {
          try {
            await agentWorker?.setStatus(workerId, 'running');
          } catch (err) {
            log.warn('onUnblock setStatus failed', { workerId, err: String(err) });
          }
        },
      });

      // buildTools factory captures the worker-side tool context and
      // returns a fresh NeuraAgentTool[] array per AgentSession. The
      // factory runs at createAgentSession time with the worker id,
      // so per-worker custom tools (request_clarification) can close
      // over that id for status callbacks and answer routing.
      //
      // Workers do NOT get vision tools — that's a deliberate design
      // decision documented in neura-tools.ts. Vision is an
      // orchestrator concern: grok is the one looking at the user's
      // screen via its voice-session `describe_screen` tool call,
      // and any visual context workers need is passed to them as
      // text in the task description. The queryWatcher field on
      // ToolCallContext is vestigial from the worker POV — neura-
      // tools.ts no longer registers any tool that reads it — but
      // we still satisfy the interface with a noop so the worker
      // context shape doesn't fork from the orchestrator context.
      const buildTools = ({
        workerId,
        taskId,
      }: {
        workerId: string;
        taskId?: string;
      }): NeuraAgentTool[] => {
        const workerTaskTools = buildWorkerTaskTools(workerId);
        const baseTools = buildNeuraTools({
          queryWatcher: () =>
            Promise.resolve('vision is not available to workers; orchestrator owns screen access'),
          memoryTools: workerMemoryTools,
          taskTools: workerTaskTools,
        });

        // Phase 6b — append the worker protocol verb tools when this
        // session has a linked task. Dispatch-for-task always passes
        // taskId; resume after a core restart currently doesn't (Wave 5
        // will thread it through). Without taskId the verb tools can't
        // target anything so we skip them rather than building broken
        // closures.
        if (taskId && clarificationBridge) {
          baseTools.push(
            ...buildWorkerProtocolTools({
              workerId,
              taskId,
              taskTools: workerTaskTools,
              clarificationBridge,
              db: rawDb,
            })
          );
        } else if (clarificationBridge) {
          // Legacy path — the standalone `request_clarification` tool
          // (kept for resume-without-taskId and tests). Drops out once
          // every dispatch flows through dispatchForTask.
          baseTools.push(buildClarificationTool(workerId, clarificationBridge));
        }
        return baseTools;
      };

      // Build the pi runtime. getModel throws if the provider isn't
      // registered — wrap in try/catch so a missing model config
      // doesn't fail the whole core startup.
      const { getModel } = await import('@mariozechner/pi-ai');
      const { provider: wProvider, model: wModel } = workerRoute;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const model = getModel(wProvider as any, wModel);
      if (!model) {
        throw new Error(
          `${wProvider}/${wModel} model not registered in pi-ai. ` +
            'Check config.routing.worker or verify pi-ai supports this provider.'
        );
      }

      // Bridge Neura's config.providers[*].apiKey into pi's AuthStorage.
      // Without this, workers die on first prompt with "No API key found
      // for <provider>" because pi resolves keys from its own auth.json
      // (which we never populate). Runtime overrides stay in memory —
      // priority 1 in pi's resolution — so config.json remains the
      // single source of truth. Pi will still create an empty auth.json
      // at the configured path; we don't write credentials into it.
      const authStorage = AuthStorage.create(join(agentDir, 'auth.json'));
      const seededProviders = seedAuthStorageFromConfig(authStorage, config.providers);
      log.info('seeded pi auth storage from config', { count: seededProviders });

      const piRuntime = new PiRuntime({
        model,
        thinkingLevel: 'low',
        cwd: process.cwd(),
        agentDir,
        sessionDir,
        buildTools,
        voiceFanoutBridge,
        skillRegistry,
        authStorage,
      });

      // AgentWorker uses the same hoisted PGlite handle.
      agentWorker = new AgentWorker({ db: rawDb, runtime: piRuntime });

      // Run the startup recovery sweep. Marks any stranded mid-run
      // workers as crashed and preserves resumable idle_partial rows.
      await agentWorker.recoverFromCrash();

      // Build the Grok-facing SkillToolHandler that surfaces the skill
      // registry for list_skills / get_skill / promote_skill. Worker
      // dispatch moved to the task-driven path in Phase 6b; skills are
      // now reference docs, not a capability gate.
      skillToolHandler = buildSkillToolHandler({
        registry: skillRegistry,
        watcher: skillWatcher,
      });

      // Worker control handler — surfaces pause / resume / cancel /
      // list_active_workers as grok tool calls. Grok decides when to
      // call these based on the orchestrator skill's system-prompt
      // directives (no keyword classifier).
      workerControlHandler = buildWorkerControlHandler({ worker: agentWorker });

      // System-state handler backs the orchestrator's `get_system_state`
      // tool. Reads from existing tables (workers, work_items,
      // task_comments) — no new schema.
      systemStateHandler = buildSystemStateHandler({ store, db: rawDb });

      // Worker dispatch handler backs the orchestrator's `dispatch_worker`
      // tool. Loads the task row, creates a worktree dir, builds the
      // canonical prompt, and hands off to `AgentWorker.dispatchForTask`.
      workerDispatchHandler = {
        dispatchWorker: async (taskId: string) => {
          if (!agentWorker) return { error: 'worker runtime not available' };
          try {
            const handle = await agentWorker.dispatchForTask(taskId);
            return { workerId: handle.workerId };
          } catch (err) {
            log.warn('dispatchForTask failed', { taskId, err: String(err) });
            return { error: String(err) };
          }
        },
      };

      log.info('phase 6 worker runtime ready');
    } catch (err) {
      log.error('phase 6 initialization failed — skills and workers disabled', {
        err: String(err),
      });
      // Null everything out so downstream callers see a consistent
      // "unavailable" state.
      skillRegistry = null;
      skillWatcher = null;
      agentWorker = null;
      voiceFanoutBridge = null;
      clarificationBridge = null;
      skillToolHandler = null;
      workerControlHandler = null;
      systemStateHandler = null;
      workerDispatchHandler = null;
    }
  } else {
    log.info('phase 6 disabled — missing store or worker route/API key');
  }

  return {
    config,
    registry,
    store,
    memoryManager,
    backupService,
    discoveryLoop,
    connectedClients,
    skillRegistry,
    skillWatcher,
    agentWorker,
    voiceFanoutBridge,
    clarificationBridge,
    skillToolHandler,
    workerControlHandler,
    systemStateHandler,
    workerDispatchHandler,
    version,
    pendingCleanups,
  };
}

/**
 * Build the Grok-facing SkillToolHandler that backs `list_skills` /
 * `get_skill` / `promote_skill`. Owns the glue between the skill registry
 * and the skill watcher.
 *
 * Phase 6b: `run_skill`, `create_skill`, `import_skill` were removed.
 * Execution flows through task dispatch (`dispatch_worker`), not skills.
 */
function buildSkillToolHandler(deps: {
  registry: SkillRegistry;
  watcher: SkillWatcher;
}): SkillToolHandler {
  const { registry, watcher } = deps;

  const handler: SkillToolHandler = {
    listSkills: (): NeuraSkill[] => registry.list(),

    getSkill: (name: string): NeuraSkill | undefined => registry.get(name),

    promoteSkill: async (skillName: string): Promise<{ promoted: boolean }> => {
      const skill = registry.get(skillName);
      if (!skill) return { promoted: false };
      if (!skill.disableModelInvocation) return { promoted: true }; // already promoted

      // Rewrite the SKILL.md frontmatter to clear the draft flag, then
      // reload the registry so the change is immediately visible.
      // Minimal regex rewrite — the file format is tightly controlled
      // so there are no edge cases around whitespace or quoting.
      const { readFileSync, writeFileSync } = await import('node:fs');
      const content = readFileSync(skill.filePath, 'utf8');
      const updated = content.replace(
        /disable-model-invocation:\s*true/,
        'disable-model-invocation: false'
      );
      if (updated === content) {
        log.warn('promote_skill did not find the draft flag to clear', {
          skillName,
          filePath: skill.filePath,
        });
        return { promoted: false };
      }
      writeFileSync(skill.filePath, updated, 'utf8');
      watcher.reloadNow();
      return { promoted: true };
    },
  };

  return handler;
}

/**
 * Build the WorkerControlHandler that backs `pause_worker`,
 * `resume_worker`, `cancel_worker`, and `list_active_workers`.
 * Target resolution is simple: if the caller provides a `workerId`,
 * use it. Otherwise, pick the most recent non-terminal worker via
 * `getMostRecentActiveWorker()`. Returns a structured result on
 * every call so Grok can narrate back which worker it acted on.
 */
function buildWorkerControlHandler(deps: { worker: AgentWorker }): WorkerControlHandler {
  const { worker } = deps;

  /**
   * Resolve an implicit target workerId. `mode` picks the fallback
   * pool when no explicit id was provided: `active` for pause/cancel
   * (any non-terminal worker is a valid target) and `paused` for
   * resume (only `idle_partial` workers are resumable, so selecting
   * a running worker would either fail with "no session_file" or
   * reopen a live session — see C1 in the PR review).
   */
  async function resolveTarget(
    explicitId: string | undefined,
    mode: 'active' | 'paused'
  ): Promise<{ workerId: string } | { error: string }> {
    if (explicitId) return { workerId: explicitId };
    const fallback =
      mode === 'paused'
        ? await worker.getMostRecentPausedWorker()
        : await worker.getMostRecentActiveWorker();
    if (!fallback) {
      return {
        error: mode === 'paused' ? 'no paused workers to resume' : 'no active workers',
      };
    }
    return { workerId: fallback.workerId };
  }

  const handler: WorkerControlHandler = {
    pauseWorker: async (
      explicitId?: string
    ): Promise<{ paused: boolean; workerId: string | null; reason?: string }> => {
      const target = await resolveTarget(explicitId, 'active');
      if ('error' in target) {
        return { paused: false, workerId: null, reason: target.error };
      }
      try {
        await worker.steer(
          target.workerId,
          "PAUSE. The user asked you to pause. Stop after the current tool call finishes and wait. Don't start new work until resumed."
        );
        await worker.waitForIdle(target.workerId);
        return { paused: true, workerId: target.workerId };
      } catch (err) {
        return {
          paused: false,
          workerId: target.workerId,
          reason: String(err),
        };
      }
    },

    resumeWorker: async (
      explicitId?: string,
      message?: string
    ): Promise<{ resumed: boolean; workerId: string | null; reason?: string }> => {
      const target = await resolveTarget(explicitId, 'paused');
      if ('error' in target) {
        return { resumed: false, workerId: null, reason: target.error };
      }
      try {
        const resumePrompt = message
          ? `OK, resume the task. Extra context: ${message}`
          : 'OK, continue the task you were working on. Pick up where you left off.';
        await worker.resume(target.workerId, resumePrompt);
        return { resumed: true, workerId: target.workerId };
      } catch (err) {
        return {
          resumed: false,
          workerId: target.workerId,
          reason: String(err),
        };
      }
    },

    cancelWorker: async (
      explicitId?: string
    ): Promise<{ cancelled: boolean; workerId: string | null; reason?: string }> => {
      const target = await resolveTarget(explicitId, 'active');
      if ('error' in target) {
        return { cancelled: false, workerId: null, reason: target.error };
      }
      try {
        await worker.cancel(target.workerId);
        return { cancelled: true, workerId: target.workerId };
      } catch (err) {
        return {
          cancelled: false,
          workerId: target.workerId,
          reason: String(err),
        };
      }
    },

    listActive: async () => {
      const workers = await worker.listActiveWorkers();
      return workers.map((w) => ({
        workerId: w.workerId,
        status: w.status,
        skillName: w.taskSpec.skillName,
        startedAt: w.startedAt,
      }));
    },
  };

  return handler;
}

export async function shutdown(
  services: CoreServices,
  httpServer: Server,
  wss: WebSocketServer | null
): Promise<void> {
  log.info('shutting down');
  // Force exit if graceful shutdown hangs (e.g. client doesn't disconnect)
  const forceExit = setTimeout(() => process.exit(1), 5000);
  forceExit.unref();

  services.discoveryLoop?.stop();
  services.backupService?.stop();

  // Phase 6: cancel every active worker, reject any pending
  // clarifications so waiting workers observe a clean failure instead
  // of hanging, and stop the skill watcher so pi sessions and fs
  // watchers don't keep the process alive.
  services.clarificationBridge?.rejectAll('core shutting down');
  if (services.agentWorker) {
    try {
      await services.agentWorker.cancelAll();
    } catch (err) {
      log.warn('agentWorker.cancelAll failed during shutdown', { err: String(err) });
    }
  }
  if (services.skillWatcher) {
    try {
      await services.skillWatcher.stop();
    } catch (err) {
      log.warn('skillWatcher.stop failed during shutdown', { err: String(err) });
    }
  }

  // Close WSS first — triggers ws 'close' handlers which finalize sessions in store.
  // Then await all in-flight session cleanups before closing the store.
  if (wss) {
    wss.close(() => {
      void (async () => {
        await Promise.allSettled([...services.pendingCleanups]);
        await services.memoryManager?.close();
        await services.backupService
          ?.backup()
          .catch((err) => log.warn('final backup failed', { err: String(err) }));
        await services.store?.close();
        httpServer.close(() => process.exit(0));
      })();
    });
  } else {
    await services.memoryManager?.close();
    await services.backupService
      ?.backup()
      .catch((err) => log.warn('final backup failed', { err: String(err) }));
    await services.store?.close();
    httpServer.close(() => process.exit(0));
  }
}
