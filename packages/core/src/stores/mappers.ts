import type {
  FactEntry,
  SessionSummaryEntry,
  WorkItemEntry,
  TranscriptChunkEntry,
} from '@neura/types';
import type { PGlite } from '@electric-sql/pglite';

/** Raw DB row shape for facts table (snake_case column names). */
export interface FactRow {
  id: string;
  content: string;
  category: string;
  tags: string[];
  source_session_id: string | null;
  confidence: number;
  access_count: number;
  last_accessed_at: string | null;
  created_at: string;
  updated_at: string;
  expires_at: string | null;
  valid_from?: string | null;
  valid_to?: string | null;
  superseded_by?: string | null;
  tag_path?: string | null;
}

/** Raw DB row shape for transcript_chunks table. */
export interface TranscriptChunkRow {
  id: string;
  session_id: string;
  chunk_text: string;
  start_transcript_id: number;
  end_transcript_id: number;
  created_at: string;
  embedding?: string | null;
}

export function mapFact(r: FactRow): FactEntry {
  return {
    id: r.id,
    content: r.content,
    category: r.category as FactEntry['category'],
    tags: r.tags,
    sourceSessionId: r.source_session_id,
    confidence: r.confidence,
    accessCount: r.access_count,
    lastAccessedAt: r.last_accessed_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    expiresAt: r.expires_at,
    validFrom: r.valid_from ?? undefined,
    validTo: r.valid_to ?? undefined,
    supersededBy: r.superseded_by ?? undefined,
    tagPath: r.tag_path ?? undefined,
  };
}

export function mapSummary(r: {
  id: string;
  session_id: string;
  summary: string;
  topics: string[];
  key_decisions: string[];
  open_threads: string[];
  extraction_model: string;
  extraction_cost_usd: number | null;
  created_at: string;
}): SessionSummaryEntry {
  return {
    id: r.id,
    sessionId: r.session_id,
    summary: r.summary,
    topics: r.topics,
    keyDecisions: r.key_decisions,
    openThreads: r.open_threads,
    extractionModel: r.extraction_model,
    extractionCostUsd: r.extraction_cost_usd,
    createdAt: r.created_at,
  };
}

export function mapWorkItem(r: {
  id: string;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  due_at: string | null;
  parent_id: string | null;
  source_session_id: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}): WorkItemEntry {
  return {
    id: r.id,
    title: r.title,
    description: r.description,
    status: r.status as WorkItemEntry['status'],
    priority: r.priority as WorkItemEntry['priority'],
    dueAt: r.due_at,
    parentId: r.parent_id,
    sourceSessionId: r.source_session_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    completedAt: r.completed_at,
  };
}

export function mapTranscriptChunk(r: TranscriptChunkRow): TranscriptChunkEntry {
  const entry: TranscriptChunkEntry = {
    id: r.id,
    sessionId: r.session_id,
    chunkText: r.chunk_text,
    startTranscriptId: r.start_transcript_id,
    endTranscriptId: r.end_transcript_id,
    createdAt: r.created_at,
  };
  // Parse embedding string from Postgres vector format for backup inclusion
  if (r.embedding) {
    const vecStr = r.embedding.replace(/^\[|\]$/g, '');
    entry.embedding = vecStr.split(',').map(Number);
  }
  return entry;
}

/** Update the tsvector column for a fact (application-managed full-text search). */
export async function updateFactTsv(db: PGlite, factId: string): Promise<void> {
  await db.query(
    `UPDATE facts SET tsv = to_tsvector('english',
      content || ' ' || COALESCE((SELECT string_agg(value, ' ') FROM jsonb_array_elements_text(tags)), '')
    ) WHERE id = $1`,
    [factId]
  );
}
