import type { PGlite } from '@electric-sql/pglite';
import crypto from 'crypto';
import type { FactEntry, TranscriptChunkEntry } from '@neura/types';
import { mapFact, mapTranscriptChunk } from './mappers.js';
import type { FactRow, TranscriptChunkRow } from './mappers.js';

// --- Phase 5b: Hybrid Retrieval ---

export async function searchFactsHybrid(
  db: PGlite,
  query: string,
  embedding?: number[],
  limit = 10
): Promise<FactEntry[]> {
  const embeddingStr = embedding ? `[${embedding.join(',')}]` : null;

  // If we have an embedding, use RRF fusion of vector + BM25
  if (embeddingStr) {
    const result = await db.query<FactRow>(
      `WITH vector_results AS (
        SELECT id, content, category, tags, source_session_id, confidence,
               access_count, last_accessed_at, created_at, updated_at, expires_at,
               valid_from, valid_to, superseded_by, tag_path,
               ROW_NUMBER() OVER (ORDER BY embedding <=> $1::vector) AS vec_rank
        FROM facts
        WHERE embedding IS NOT NULL
          AND confidence >= 0.2
          AND valid_to IS NULL
          AND (expires_at IS NULL OR expires_at > NOW())
        ORDER BY embedding <=> $1::vector
        LIMIT $2
      ),
      text_results AS (
        SELECT id, content, category, tags, source_session_id, confidence,
               access_count, last_accessed_at, created_at, updated_at, expires_at,
               valid_from, valid_to, superseded_by, tag_path,
               ROW_NUMBER() OVER (ORDER BY ts_rank_cd(tsv, plainto_tsquery('english', $3)) DESC) AS text_rank
        FROM facts
        WHERE tsv @@ plainto_tsquery('english', $3)
          AND confidence >= 0.2
          AND valid_to IS NULL
          AND (expires_at IS NULL OR expires_at > NOW())
        ORDER BY ts_rank_cd(tsv, plainto_tsquery('english', $3)) DESC
        LIMIT $2
      )
      SELECT COALESCE(v.id, t.id) AS id,
             COALESCE(v.content, t.content) AS content,
             COALESCE(v.category, t.category) AS category,
             COALESCE(v.tags, t.tags) AS tags,
             COALESCE(v.source_session_id, t.source_session_id) AS source_session_id,
             COALESCE(v.confidence, t.confidence) AS confidence,
             COALESCE(v.access_count, t.access_count) AS access_count,
             COALESCE(v.last_accessed_at, t.last_accessed_at) AS last_accessed_at,
             COALESCE(v.created_at, t.created_at) AS created_at,
             COALESCE(v.updated_at, t.updated_at) AS updated_at,
             COALESCE(v.expires_at, t.expires_at) AS expires_at,
             COALESCE(v.valid_from, t.valid_from) AS valid_from,
             COALESCE(v.valid_to, t.valid_to) AS valid_to,
             COALESCE(v.superseded_by, t.superseded_by) AS superseded_by,
             COALESCE(v.tag_path, t.tag_path) AS tag_path,
             (1.0 / (60 + COALESCE(v.vec_rank, 999))) +
             (1.0 / (60 + COALESCE(t.text_rank, 999))) AS rrf_score
      FROM vector_results v
      FULL OUTER JOIN text_results t ON v.id = t.id
      ORDER BY rrf_score DESC
      LIMIT $2`,
      [embeddingStr, limit, query]
    );
    return result.rows.map((r) => mapFact(r));
  }

  // Fallback: text-only BM25 search
  const result = await db.query<FactRow>(
    `SELECT * FROM facts
     WHERE tsv @@ plainto_tsquery('english', $1)
       AND valid_to IS NULL
       AND (expires_at IS NULL OR expires_at > NOW())
     ORDER BY ts_rank_cd(tsv, plainto_tsquery('english', $1)) DESC
     LIMIT $2`,
    [query, limit]
  );
  return result.rows.map((r) => mapFact(r));
}

export async function searchTranscripts(
  db: PGlite,
  embedding: number[],
  limit = 10,
  sessionId?: string
): Promise<TranscriptChunkEntry[]> {
  const embeddingStr = `[${embedding.join(',')}]`;

  // Primary: search the transcript_chunks table
  const params: (string | number)[] = [embeddingStr];
  let where = 'WHERE embedding IS NOT NULL';
  if (sessionId) {
    params.push(sessionId);
    where += ` AND session_id = $${params.length}`;
  }
  params.push(limit);
  const result = await db.query<TranscriptChunkRow>(
    `SELECT id, session_id, chunk_text, start_transcript_id, end_transcript_id, created_at
     FROM transcript_chunks
     ${where}
     ORDER BY embedding <=> $1::vector
     LIMIT $${params.length}`,
    params
  );

  const chunkResults: TranscriptChunkEntry[] = result.rows.map((r) => mapTranscriptChunk(r));

  // Also search legacy per-row embeddings (pre-chunks data from upgraded databases)
  const remaining = limit - chunkResults.length;
  if (remaining > 0) {
    const legacyParams: (string | number)[] = [embeddingStr];
    let legacyWhere = 'WHERE embedding IS NOT NULL';
    if (sessionId) {
      legacyParams.push(sessionId);
      legacyWhere += ` AND session_id = $${legacyParams.length}`;
    }
    legacyParams.push(remaining);
    const legacy = await db.query<{
      id: number;
      session_id: string;
      text: string;
      created_at: string;
    }>(
      `SELECT id, session_id, text, created_at FROM transcripts
       ${legacyWhere}
       ORDER BY embedding <=> $1::vector
       LIMIT $${legacyParams.length}`,
      legacyParams
    );
    const legacyResults: TranscriptChunkEntry[] = legacy.rows.map((r) => ({
      id: `legacy-${r.id}`,
      sessionId: r.session_id,
      chunkText: r.text,
      startTranscriptId: r.id,
      endTranscriptId: r.id,
      createdAt: r.created_at,
    }));
    chunkResults.push(...legacyResults);
  }

  return chunkResults;
}

export async function insertTranscriptChunks(
  db: PGlite,
  sessionId: string,
  chunks: {
    chunkText: string;
    embedding: number[];
    startTranscriptId: number;
    endTranscriptId: number;
  }[]
): Promise<void> {
  for (const chunk of chunks) {
    const id = crypto.randomUUID();
    const embeddingStr = `[${chunk.embedding.join(',')}]`;
    await db.query(
      `INSERT INTO transcript_chunks (id, session_id, chunk_text, embedding, start_transcript_id, end_transcript_id)
       VALUES ($1, $2, $3, $4::vector, $5, $6)`,
      [id, sessionId, chunk.chunkText, embeddingStr, chunk.startTranscriptId, chunk.endTranscriptId]
    );
  }
}
