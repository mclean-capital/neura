import initSqlJs, { type Database } from 'sql.js';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import type { DataStore, SessionRecord, TranscriptEntry } from '@neura/types';

export class SqliteStore implements DataStore {
  private db: Database;
  private dbPath: string | null;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  private constructor(db: Database, dbPath: string | null) {
    this.db = db;
    this.dbPath = dbPath;
    this.migrate();
  }

  static async create(dbPath?: string): Promise<SqliteStore> {
    const SQL = await initSqlJs();
    let db: Database;

    if (dbPath) {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
      if (fs.existsSync(dbPath)) {
        const buffer = fs.readFileSync(dbPath);
        db = new SQL.Database(buffer);
      } else {
        db = new SQL.Database();
      }
    } else {
      db = new SQL.Database();
    }

    return new SqliteStore(db, dbPath ?? null);
  }

  private migrate() {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        started_at TEXT NOT NULL DEFAULT (datetime('now')),
        ended_at TEXT,
        duration_ms INTEGER,
        cost_usd REAL,
        voice_provider TEXT NOT NULL,
        vision_provider TEXT NOT NULL
      )
    `);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS transcripts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES sessions(id),
        role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
        text TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    this.db.run('CREATE INDEX IF NOT EXISTS idx_transcripts_session ON transcripts(session_id)');
  }

  /** Flush in-memory DB to disk atomically (write-to-temp + rename). */
  private save() {
    if (!this.dbPath) return;
    const data = this.db.export();
    const tmpPath = this.dbPath + '.tmp';
    fs.writeFileSync(tmpPath, Buffer.from(data));
    fs.renameSync(tmpPath, this.dbPath);
  }

  /** Debounced save — at most once per second. Immediate save on close(). */
  private scheduleSave() {
    if (!this.dbPath) return;
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.save();
    }, 1000);
  }

  createSession(voiceProvider: string, visionProvider: string): string {
    const id = crypto.randomUUID();
    this.db.run('INSERT INTO sessions (id, voice_provider, vision_provider) VALUES (?, ?, ?)', [
      id,
      voiceProvider,
      visionProvider,
    ]);
    this.scheduleSave();
    return id;
  }

  endSession(sessionId: string, costUsd: number): void {
    this.db.run(
      `UPDATE sessions
       SET ended_at = datetime('now'),
           duration_ms = CAST((julianday('now') - julianday(started_at)) * 86400000 AS INTEGER),
           cost_usd = ?
       WHERE id = ?`,
      [costUsd, sessionId]
    );
    this.scheduleSave();
  }

  appendTranscript(sessionId: string, role: 'user' | 'assistant', text: string): void {
    this.db.run('INSERT INTO transcripts (session_id, role, text) VALUES (?, ?, ?)', [
      sessionId,
      role,
      text,
    ]);
    this.scheduleSave();
  }

  getSessions(limit = 50): SessionRecord[] {
    const stmt = this.db.prepare('SELECT * FROM sessions ORDER BY started_at DESC LIMIT ?');
    stmt.bind([limit]);

    const rows: SessionRecord[] = [];
    while (stmt.step()) {
      const r = stmt.getAsObject() as {
        id: string;
        started_at: string;
        ended_at: string | null;
        duration_ms: number | null;
        cost_usd: number | null;
        voice_provider: string;
        vision_provider: string;
      };
      rows.push({
        id: r.id,
        startedAt: r.started_at,
        endedAt: r.ended_at,
        durationMs: r.duration_ms,
        costUsd: r.cost_usd,
        voiceProvider: r.voice_provider,
        visionProvider: r.vision_provider,
      });
    }
    stmt.free();
    return rows;
  }

  getTranscript(sessionId: string): TranscriptEntry[] {
    const stmt = this.db.prepare('SELECT * FROM transcripts WHERE session_id = ? ORDER BY id ASC');
    stmt.bind([sessionId]);

    const rows: TranscriptEntry[] = [];
    while (stmt.step()) {
      const r = stmt.getAsObject() as {
        id: number;
        session_id: string;
        role: 'user' | 'assistant';
        text: string;
        created_at: string;
      };
      rows.push({
        id: r.id,
        sessionId: r.session_id,
        role: r.role,
        text: r.text,
        createdAt: r.created_at,
      });
    }
    stmt.free();
    return rows;
  }

  close(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    this.save();
    this.db.close();
  }
}
