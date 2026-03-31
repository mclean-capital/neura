import Database from 'better-sqlite3';
import crypto from 'crypto';
import type { DataStore, SessionRecord, TranscriptEntry } from '@neura/types';

export class SqliteStore implements DataStore {
  private db: Database.Database;

  constructor(dbPath?: string) {
    this.db = new Database(dbPath ?? ':memory:');
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.migrate();
  }

  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        started_at TEXT NOT NULL DEFAULT (datetime('now')),
        ended_at TEXT,
        duration_ms INTEGER,
        cost_usd REAL,
        voice_provider TEXT NOT NULL,
        vision_provider TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS transcripts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES sessions(id),
        role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
        text TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_transcripts_session ON transcripts(session_id);
    `);
  }

  createSession(voiceProvider: string, visionProvider: string): string {
    const id = crypto.randomUUID();
    this.db
      .prepare('INSERT INTO sessions (id, voice_provider, vision_provider) VALUES (?, ?, ?)')
      .run(id, voiceProvider, visionProvider);
    return id;
  }

  endSession(sessionId: string, costUsd: number): void {
    this.db
      .prepare(
        `UPDATE sessions
         SET ended_at = datetime('now'),
             duration_ms = CAST((julianday('now') - julianday(started_at)) * 86400000 AS INTEGER),
             cost_usd = ?
         WHERE id = ?`
      )
      .run(costUsd, sessionId);
  }

  appendTranscript(sessionId: string, role: 'user' | 'assistant', text: string): void {
    this.db
      .prepare('INSERT INTO transcripts (session_id, role, text) VALUES (?, ?, ?)')
      .run(sessionId, role, text);
  }

  getSessions(limit = 50): SessionRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM sessions ORDER BY started_at DESC LIMIT ?')
      .all(limit) as {
      id: string;
      started_at: string;
      ended_at: string | null;
      duration_ms: number | null;
      cost_usd: number | null;
      voice_provider: string;
      vision_provider: string;
    }[];

    return rows.map((r) => ({
      id: r.id,
      startedAt: r.started_at,
      endedAt: r.ended_at,
      durationMs: r.duration_ms,
      costUsd: r.cost_usd,
      voiceProvider: r.voice_provider,
      visionProvider: r.vision_provider,
    }));
  }

  getTranscript(sessionId: string): TranscriptEntry[] {
    const rows = this.db
      .prepare('SELECT * FROM transcripts WHERE session_id = ? ORDER BY id ASC')
      .all(sessionId) as {
      id: number;
      session_id: string;
      role: 'user' | 'assistant';
      text: string;
      created_at: string;
    }[];

    return rows.map((r) => ({
      id: r.id,
      sessionId: r.session_id,
      role: r.role,
      text: r.text,
      createdAt: r.created_at,
    }));
  }

  close(): void {
    this.db.close();
  }
}
