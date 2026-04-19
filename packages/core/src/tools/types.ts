import type {
  FactEntry,
  NeuraSkill,
  SystemStateSnapshot,
  TaskCommentEntry,
  TaskCommentType,
  TaskCommentUrgency,
  TaskContext,
  TaskSource,
  WorkItemEntry,
  WorkItemPriority,
  WorkItemStatus,
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
    priority: WorkItemPriority,
    options?: {
      description?: string;
      dueAt?: string;
      sourceSessionId?: string;
      // Phase 6b enrichments — orchestrator provides at create time when it
      // has enough goal-level clarity; worker fills in more during execution.
      goal?: string;
      context?: TaskContext;
      relatedSkills?: string[];
      repoPath?: string;
      baseBranch?: string;
      source?: TaskSource;
    }
  ): Promise<string>;
  listTasks(filter?: {
    status?: WorkItemStatus | WorkItemStatus[] | 'all';
    source?: TaskSource;
    needsAttention?: boolean;
    since?: string;
    limit?: number;
  }): Promise<WorkItemEntry[]>;
  getTask(idOrTitle: string): Promise<WorkItemEntry | null>;
  /**
   * Update a task. Payload can include field changes, a comment, and/or
   * explicit status transitions. Returns the updated task + the new version
   * number (from the optimistic lock). `null` when the task can't be found.
   */
  updateTask(
    idOrTitle: string,
    payload: UpdateTaskPayload
  ): Promise<{ task: WorkItemEntry; version: number; comment?: TaskCommentEntry } | null>;
  deleteTask(idOrTitle: string): Promise<boolean>;
}

/**
 * Payload for {@link TaskToolHandler.updateTask}. Workers and the orchestrator
 * share this shape; the handler derives the author tag from the tool-call
 * context and enforces which actors may set which fields (see
 * docs/phase6b-task-driven-execution.md §Concurrency → Handler-level
 * backstops).
 */
export interface UpdateTaskPayload {
  /** Optional status transition (subject to the transition matrix). */
  status?: WorkItemStatus;
  /** Optional comment to append. */
  comment?: {
    type: TaskCommentType;
    content: string;
    urgency?: TaskCommentUrgency;
    metadata?: Record<string, unknown>;
    attachmentPath?: string;
  };
  /** Optional field updates the caller is authorized to make. */
  fields?: {
    title?: string;
    priority?: WorkItemPriority;
    description?: string | null;
    dueAt?: string | null;
    goal?: string | null;
    context?: TaskContext | null;
    relatedSkills?: string[];
    repoPath?: string | null;
    baseBranch?: string | null;
    workerId?: string | null;
    leaseExpiresAt?: string | null;
  };
  /** Optimistic-lock version the caller read before editing. */
  expectVersion?: number;
}

/**
 * Phase 6b — worker dispatch handler. Single entry point for "kick off an
 * agent worker against an existing task row." Returns the worker id
 * immediately; progress flows via comments on the task.
 */
export interface WorkerDispatchHandler {
  dispatchWorker(taskId: string): Promise<{ workerId: string } | { error: string }>;
}

/**
 * Phase 6b — system-state handler. Returns a single snapshot the
 * orchestrator queries opportunistically to know what needs attention.
 */
export interface SystemStateHandler {
  getSystemState(): Promise<SystemStateSnapshot>;
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
  workerDispatch?: WorkerDispatchHandler;
  systemState?: SystemStateHandler;
  /**
   * Actor identity for `update_task`. Workers pass `worker:<workerId>`;
   * orchestrator leaves it unset (defaults to `orchestrator`). The handler
   * uses this to enforce transition-matrix + author-scoping invariants.
   */
  actor?: string;
}

/** Re-export for convenience — callers depend on these along with the context. */
export type { WorkerResult, WorkerTask };
