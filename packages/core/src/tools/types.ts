import type { FactEntry, WorkItemEntry, TimelineEntry, MemoryStats } from '@neura/types';

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

/** Callback for presence mode changes triggered by AI tool calls */
export type EnterModeHandler = (mode: 'passive' | 'active') => void;

/** Context object passed to handleToolCall */
export interface ToolCallContext {
  queryWatcher: (prompt: string, source: 'camera' | 'screen') => Promise<string>;
  memoryTools?: MemoryToolHandler;
  enterMode?: EnterModeHandler;
  taskTools?: TaskToolHandler;
}
