/** Memory type discriminator */
export type MemoryType = 'identity' | 'user_profile' | 'fact' | 'preference' | 'session_summary';

/** Identity attribute — who Neura is */
export interface IdentityEntry {
  id: string;
  attribute: string;
  value: string;
  source: 'default' | 'user_feedback';
  sourceSessionId: string | null;
  createdAt: string;
  updatedAt: string;
}

/** User profile field — who the user is */
export interface UserProfileEntry {
  id: string;
  field: string;
  value: string;
  confidence: number;
  sourceSessionId: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Extracted fact — durable knowledge with optional vector embedding */
export interface FactEntry {
  id: string;
  content: string;
  category: 'project' | 'technical' | 'business' | 'personal' | 'general';
  tags: string[];
  sourceSessionId: string | null;
  confidence: number;
  accessCount: number;
  lastAccessedAt: string | null;
  createdAt: string;
  updatedAt: string;
  expiresAt: string | null;
  /** Phase 5b: temporal validity — when this fact became true */
  validFrom?: string;
  /** Phase 5b: temporal validity — when this fact stopped being true (null = still valid) */
  validTo?: string | null;
  /** Phase 5b: ID of the fact that replaced this one */
  supersededBy?: string | null;
  /** Phase 5b: hierarchical tag path (dot-separated, e.g. "project.neura.memory") */
  tagPath?: string;
}

/** Behavioral preference — corrections and confirmations */
export interface PreferenceEntry {
  id: string;
  preference: string;
  category: 'response_style' | 'workflow' | 'communication' | 'technical' | 'general';
  strength: number;
  sourceSessionId: string | null;
  reinforcementCount: number;
  createdAt: string;
  updatedAt: string;
}

/** Auto-generated session summary */
export interface SessionSummaryEntry {
  id: string;
  sessionId: string;
  summary: string;
  topics: string[];
  keyDecisions: string[];
  openThreads: string[];
  extractionModel: string;
  extractionCostUsd: number | null;
  createdAt: string;
}

/** Extraction job status */
export interface MemoryExtractionRecord {
  id: string;
  sessionId: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  memoriesCreated: number;
  error: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

/** Composite memory context assembled for system prompt injection */
export interface MemoryContext {
  identity: IdentityEntry[];
  userProfile: UserProfileEntry[];
  recentFacts: FactEntry[];
  preferences: PreferenceEntry[];
  recentSummaries: SessionSummaryEntry[];
  tokenEstimate: number;
}

/** Shape of ~/.neura/memory-backup.json */
export interface MemoryBackup {
  version: 1 | 2;
  exportedAt: string;
  identity: IdentityEntry[];
  userProfile: UserProfileEntry[];
  facts: FactEntry[];
  preferences: PreferenceEntry[];
  sessionSummaries: SessionSummaryEntry[];
  /** Phase 5b v2: entity data */
  entities?: EntityEntry[];
  entityRelationships?: EntityRelationship[];
  factEntities?: FactEntity[];
}

/** Work item status */
export type WorkItemStatus = 'pending' | 'in_progress' | 'done' | 'cancelled' | 'failed';

/** Work item priority */
export type WorkItemPriority = 'low' | 'medium' | 'high';

/** Work item — a task created by the user or the discovery loop */
export interface WorkItemEntry {
  id: string;
  title: string;
  description: string | null;
  status: WorkItemStatus;
  priority: WorkItemPriority;
  dueAt: string | null;
  parentId: string | null;
  sourceSessionId: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

/** Output from the extraction pipeline */
export interface ExtractionResult {
  facts: {
    content: string;
    category: string;
    tags: string[];
    tagPath?: string;
    /** Phase 5b: entity names mentioned in this fact (for precise fact-entity linking) */
    mentionedEntities?: string[];
  }[];
  preferences: { preference: string; category: string }[];
  userProfile: { field: string; value: string }[];
  identityUpdates: { attribute: string; value: string }[];
  sessionSummary: {
    summary: string;
    topics: string[];
    keyDecisions: string[];
    openThreads: string[];
  };
  /** Phase 5b: extracted entities and relationships */
  entities?: {
    name: string;
    type: 'person' | 'project' | 'tool' | 'company' | 'concept';
    relationships: { target: string; relationship: string }[];
  }[];
}

// --- Phase 5b types ---

/** Retrieval strategy for memory recall */
export type RetrievalStrategy = 'vector-only' | 'hybrid' | 'hybrid-rerank';

/** Per-tier token budgets for system prompt assembly */
export interface MemoryTierConfig {
  l0Budget: number;
  l1Budget: number;
  l2Budget: number;
}

/** Entity — a person, project, tool, company, or concept mentioned in facts */
export interface EntityEntry {
  id: string;
  name: string;
  type: 'person' | 'project' | 'tool' | 'company' | 'concept';
  canonicalName: string;
  createdAt: string;
}

/** Relationship between two entities with temporal validity */
export interface EntityRelationship {
  id: string;
  sourceEntityId: string;
  targetEntityId: string;
  relationship: string;
  validFrom: string;
  validTo: string | null;
  sourceFactId: string | null;
  createdAt: string;
}

/** Junction linking a fact to the entities it mentions */
export interface FactEntity {
  factId: string;
  entityId: string;
}

/** Timeline event for chronological queries */
export interface TimelineEntry {
  type: 'fact_created' | 'fact_invalidated' | 'entity_created' | 'relationship_created';
  timestamp: string;
  content: string;
  entityName?: string;
  factId?: string;
}

/** Aggregate memory statistics */
export interface MemoryStats {
  totalFacts: number;
  activeFacts: number;
  expiredFacts: number;
  topCategories: Record<string, number>;
  totalEntities: number;
  totalRelationships: number;
  oldestFact: string | null;
  newestFact: string | null;
  totalTranscriptsIndexed: number;
  storageEstimate: string;
}
