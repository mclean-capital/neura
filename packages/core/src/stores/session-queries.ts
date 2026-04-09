import type { PGlite } from '@electric-sql/pglite';
import crypto from 'crypto';
import type { SessionRecord, TranscriptEntry } from '@neura/types';

// --- Session methods ---

export async function createSession(
  db: PGlite,
  voiceProvider: string,
  visionProvider: string
): Promise<string> {
  const id = crypto.randomUUID();
  await db.query('INSERT INTO sessions (id, voice_provider, vision_provider) VALUES ($1, $2, $3)', [
    id,
    voiceProvider,
    visionProvider,
  ]);
  return id;
}

export async function endSession(db: PGlite, sessionId: string, costUsd: number): Promise<void> {
  await db.query(
    `UPDATE sessions
     SET ended_at = NOW(),
         duration_ms = (EXTRACT(EPOCH FROM (NOW() - started_at)) * 1000)::INTEGER,
         cost_usd = $1
     WHERE id = $2`,
    [costUsd, sessionId]
  );
}

export async function appendTranscript(
  db: PGlite,
  sessionId: string,
  role: 'user' | 'assistant',
  text: string
): Promise<void> {
  await db.query('INSERT INTO transcripts (session_id, role, text) VALUES ($1, $2, $3)', [
    sessionId,
    role,
    text,
  ]);
}

export async function getSessions(db: PGlite, limit = 50): Promise<SessionRecord[]> {
  const result = await db.query<{
    id: string;
    started_at: string;
    ended_at: string | null;
    duration_ms: number | null;
    cost_usd: number | null;
    voice_provider: string;
    vision_provider: string;
  }>('SELECT * FROM sessions ORDER BY started_at DESC LIMIT $1', [limit]);

  return result.rows.map((r) => ({
    id: r.id,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    durationMs: r.duration_ms,
    costUsd: r.cost_usd,
    voiceProvider: r.voice_provider,
    visionProvider: r.vision_provider,
  }));
}

export async function getTranscript(db: PGlite, sessionId: string): Promise<TranscriptEntry[]> {
  const result = await db.query<{
    id: number;
    session_id: string;
    role: 'user' | 'assistant';
    text: string;
    created_at: string;
  }>('SELECT * FROM transcripts WHERE session_id = $1 ORDER BY id ASC', [sessionId]);

  return result.rows.map((r) => ({
    id: r.id,
    sessionId: r.session_id,
    role: r.role,
    text: r.text,
    createdAt: r.created_at,
  }));
}
