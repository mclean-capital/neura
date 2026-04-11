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
 * Phase 6 — skill tool handler. Thin interface over SkillRegistry +
 * AgentWorker so the tool-router stays decoupled from their
 * implementations. The concrete instance is wired in lifecycle.ts.
 */
export interface SkillToolHandler {
  /** Return every loaded skill (including drafts) for `list_skills`. */
  listSkills(): NeuraSkill[];
  /** Return a single skill for `get_skill`. */
  getSkill(name: string): NeuraSkill | undefined;
  /**
   * Dispatch a worker to run an existing skill. Returns the worker id
   * immediately; does NOT await completion. Progress flows via voice
   * interject from the VoiceFanoutBridge.
   */
  runSkill(skillName: string, description: string): Promise<{ workerId: string }>;
  /** Dispatch a worker that AUTHORS a new skill from a description. */
  createSkill(description: string): Promise<{ workerId: string }>;
  /** Clear the `disable-model-invocation` flag on a draft skill. */
  promoteSkill(skillName: string): Promise<{ promoted: boolean }>;
  /** Register an explicit filesystem path and reload the registry. */
  importSkill(path: string): Promise<{ imported: boolean; count: number }>;
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
}

/** Re-export for convenience — callers depend on these along with the context. */
export type { WorkerResult, WorkerTask };
