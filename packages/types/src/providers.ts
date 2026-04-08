import type {
  IdentityEntry,
  UserProfileEntry,
  FactEntry,
  PreferenceEntry,
  SessionSummaryEntry,
  MemoryExtractionRecord,
  MemoryContext,
  MemoryBackup,
  WorkItemEntry,
  WorkItemPriority,
} from './memory.js';

/** Voice provider interface — any voice backend must implement this. */
export interface VoiceProvider {
  connect(): void;
  sendAudio(base64: string): void;
  sendText(text: string): void;
  sendSystemEvent(text: string): void;
  close(): void;
}

/** Callbacks the voice provider invokes to communicate with the server. */
export interface VoiceProviderCallbacks {
  onAudio: (base64: string) => void;
  onInputTranscript: (text: string) => void;
  onOutputTranscript: (text: string) => void;
  onOutputTranscriptComplete: (text: string) => void;
  onInterrupted: () => void;
  onTurnComplete: () => void;
  onToolCall: (name: string, args: Record<string, unknown>) => void;
  onToolResult: (name: string, result: Record<string, unknown>) => void;
  onError: (error: string) => void;
  onClose: () => void;
  onReady: () => void;
  onReconnected: () => void;
  queryWatcher: (prompt: string, source: 'camera' | 'screen') => Promise<string>;
}

/** Vision provider interface — any vision backend must implement this. */
export interface VisionProvider {
  connect(): Promise<void>;
  sendFrame(base64Jpeg: string): void;
  query(prompt: string): Promise<string>;
  isConnected(): boolean;
  close(): void;
}

/** Provider pricing rates for cost tracking. */
export interface ProviderPricing {
  voiceRatePerMs: number;
  visionRatePerMs: number;
}

/** Abstract data store interface for session persistence and memory. */
export interface DataStore {
  // Session management
  createSession(voiceProvider: string, visionProvider: string): Promise<string>;
  endSession(sessionId: string, costUsd: number): Promise<void>;
  appendTranscript(sessionId: string, role: 'user' | 'assistant', text: string): Promise<void>;
  getSessions(limit?: number): Promise<SessionRecord[]>;
  getTranscript(sessionId: string): Promise<TranscriptEntry[]>;

  // Identity
  getIdentity(): Promise<IdentityEntry[]>;
  upsertIdentity(
    attribute: string,
    value: string,
    source: 'default' | 'user_feedback',
    sourceSessionId?: string
  ): Promise<void>;

  // User profile
  getUserProfile(): Promise<UserProfileEntry[]>;
  upsertUserProfile(
    field: string,
    value: string,
    confidence: number,
    sourceSessionId?: string
  ): Promise<void>;

  // Facts
  getFacts(options?: {
    category?: string;
    limit?: number;
    minConfidence?: number;
  }): Promise<FactEntry[]>;
  searchFacts(query: string, embedding?: number[], limit?: number): Promise<FactEntry[]>;
  upsertFact(
    content: string,
    category: string,
    tags: string[],
    sourceSessionId?: string,
    confidence?: number,
    embedding?: number[]
  ): Promise<string>;
  touchFact(id: string): Promise<void>;
  deleteFact(id: string): Promise<void>;

  // Preferences
  getPreferences(options?: { category?: string; minStrength?: number }): Promise<PreferenceEntry[]>;
  upsertPreference(preference: string, category: string, sourceSessionId?: string): Promise<void>;
  reinforcePreference(id: string): Promise<void>;

  // Session summaries
  getSessionSummary(sessionId: string): Promise<SessionSummaryEntry | null>;
  getRecentSummaries(limit?: number): Promise<SessionSummaryEntry[]>;
  createSessionSummary(
    sessionId: string,
    summary: Omit<SessionSummaryEntry, 'id' | 'sessionId' | 'createdAt'>
  ): Promise<void>;

  // Extraction tracking
  createExtraction(sessionId: string): Promise<string>;
  updateExtraction(
    id: string,
    status: 'pending' | 'processing' | 'completed' | 'failed',
    memoriesCreated?: number,
    error?: string
  ): Promise<void>;
  getPendingExtractions(): Promise<MemoryExtractionRecord[]>;

  // Composite context for system prompt injection
  getMemoryContext(options?: { maxTokens?: number }): Promise<MemoryContext>;

  // Work items
  getOpenWorkItems(limit?: number): Promise<WorkItemEntry[]>;
  getWorkItems(options?: { status?: string; limit?: number }): Promise<WorkItemEntry[]>;
  getWorkItem(id: string): Promise<WorkItemEntry | null>;
  createWorkItem(
    title: string,
    priority: WorkItemPriority,
    options?: {
      description?: string;
      dueAt?: string;
      parentId?: string;
      sourceSessionId?: string;
    }
  ): Promise<string>;
  updateWorkItem(
    id: string,
    updates: Partial<Pick<WorkItemEntry, 'status' | 'priority' | 'title' | 'description' | 'dueAt'>>
  ): Promise<void>;
  deleteWorkItem(id: string): Promise<void>;

  // Backup & recovery
  exportMemories(): Promise<MemoryBackup>;
  importMemories(backup: MemoryBackup): Promise<{ imported: number; skipped: number }>;

  close(): Promise<void>;
}

export interface SessionRecord {
  id: string;
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  costUsd: number | null;
  voiceProvider: string;
  visionProvider: string;
}

export interface TranscriptEntry {
  id: number;
  sessionId: string;
  role: 'user' | 'assistant';
  text: string;
  createdAt: string;
}
