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

/** Output from the extraction pipeline */
export interface ExtractionResult {
  facts: { content: string; category: string; tags: string[] }[];
  preferences: { preference: string; category: string }[];
  userProfile: { field: string; value: string }[];
  identityUpdates: { attribute: string; value: string }[];
  sessionSummary: {
    summary: string;
    topics: string[];
    keyDecisions: string[];
    openThreads: string[];
  };
}
