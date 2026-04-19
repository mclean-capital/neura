import type {
  FactEntry,
  NeuraSkill,
  WorkItemEntry,
  TimelineEntry,
  MemoryStats,
  WorkerResult,
  WorkerTask,
} from '@neura/types';

export interface MemoryToolHandler {
  storeFact(content: string, category: string, tags: string[], sessionId?: string): Promise<string>;
  recall(query: string, limit?: number): Promise<FactEntry[]>;
  storePreference(preference: string, category: string, sessionId?: string): Promise<void>;
  invalidateFact(query: string): Promise<string | null>;
  getTimeline(daysBack: number, entityFilter?: string): Promise<TimelineEntry[]>;
  getMemoryStats(): Promise<MemoryStats>;
}

export interface TaskToolHandler {
  createTask(
    title: string,
    priority: string,
    options?: { description?: string; dueAt?: string; sourceSessionId?: string }
  ): Promise<string>;
  listTasks(status?: string): Promise<WorkItemEntry[]>;
  getTask(idOrTitle: string): Promise<WorkItemEntry | null>;
  updateTask(idOrTitle: string, updates: Record<string, unknown>): Promise<boolean>;
  deleteTask(idOrTitle: string): Promise<boolean>;
}

/**
 * Phase 6b — skill tool handler. Thin interface over SkillRegistry so the
 * tool-router stays decoupled from its implementation. The concrete instance
 * is wired in lifecycle.ts.
 *
 * Skills are now reference documentation (agentskills.io spec). Execution
 * flows through task dispatch (`dispatch_worker`), not through skills.
 * See docs/phase6b-task-driven-execution.md.
 */
export interface SkillToolHandler {
  /** Return every loaded skill (including drafts) for `list_skills`. */
  listSkills(): NeuraSkill[];
  /** Return a single skill for `get_skill`. */
  getSkill(name: string): NeuraSkill | undefined;
  /** Clear the `disable-model-invocation` flag on a draft skill. */
  promoteSkill(skillName: string): Promise<{ promoted: boolean }>;
}

/**
 * Phase 6 — worker control handler. Surfaces pause / resume / cancel
 * as tool calls Grok can make during a voice session, driven by the
 * orchestrator skill's system-prompt instructions. Each method takes
 * an optional `workerId` — if omitted, the handler resolves to the
 * most recent non-terminal worker. Returns the actual `workerId`
 * that was acted on so Grok can confirm the target back to the user.
 */
export interface WorkerControlHandler {
  /** Steer-pause a running worker to `idle_partial`. */
  pauseWorker(workerId?: string): Promise<{
    paused: boolean;
    workerId: string | null;
    reason?: string;
  }>;
  /** Resume a previously paused worker via SessionManager.open(). */
  resumeWorker(
    workerId?: string,
    message?: string
  ): Promise<{ resumed: boolean; workerId: string | null; reason?: string }>;
  /** Cancel a worker permanently via pi's AbortSignal. */
  cancelWorker(workerId?: string): Promise<{
    cancelled: boolean;
    workerId: string | null;
    reason?: string;
  }>;
  /** List currently-active workers so Grok can name targets. */
  listActive(): Promise<
    {
      workerId: string;
      status: string;
      skillName: string | undefined;
      startedAt: string;
    }[]
  >;
}

/** Callback for presence mode changes triggered by AI tool calls */
export type EnterModeHandler = (mode: 'passive' | 'active') => void;

/** Context object passed to handleToolCall */
export interface ToolCallContext {
  queryWatcher: (prompt: string, source: 'camera' | 'screen') => Promise<string>;
  memoryTools?: MemoryToolHandler;
  enterMode?: EnterModeHandler;
  taskTools?: TaskToolHandler;
  skillTools?: SkillToolHandler;
  workerControl?: WorkerControlHandler;
}

/** Re-export for convenience — callers depend on these along with the context. */
export type { WorkerResult, WorkerTask };
