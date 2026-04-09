/**
 * Periodic memory backup service.
 *
 * Exports valuable memory data (facts, preferences, identity, user profile,
 * session summaries) to a JSON file. On PGlite corruption, the server
 * auto-restores from this backup — session transcripts are lost but
 * memories survive.
 */

import { writeFileSync, readFileSync, renameSync, existsSync, statSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { Logger } from '@neura/utils/logger';
import { IntervalTimer } from '@neura/utils';
import type { DataStore, MemoryBackup } from '@neura/types';

const log = new Logger('backup');

export interface BackupServiceOptions {
  store: DataStore;
  backupPath: string;
  intervalMs?: number;
  staleThresholdMs?: number;
}

export class BackupService {
  private readonly store: DataStore;
  readonly backupPath: string;
  private readonly staleThresholdMs: number;
  private readonly timer: IntervalTimer;
  private backupInProgress = false;

  constructor(options: BackupServiceOptions) {
    this.store = options.store;
    this.backupPath = options.backupPath;
    this.staleThresholdMs = options.staleThresholdMs ?? 60 * 60_000;
    this.timer = new IntervalTimer(
      () => {
        void this.backup().catch((err) => log.warn('periodic backup failed', { err: String(err) }));
      },
      options.intervalMs ?? 5 * 60_000
    );
  }

  async backup(): Promise<void> {
    if (this.backupInProgress) return;
    this.backupInProgress = true;
    try {
      const data = await this.store.exportMemories();
      const json = JSON.stringify(data, null, 2);
      const tmpPath = this.backupPath + '.tmp';
      mkdirSync(dirname(this.backupPath), { recursive: true });
      writeFileSync(tmpPath, json, 'utf-8');
      renameSync(tmpPath, this.backupPath);
      const totalEntries =
        data.identity.length +
        data.userProfile.length +
        data.facts.length +
        data.preferences.length +
        data.sessionSummaries.length;
      log.info('backup saved', { entries: totalEntries, bytes: json.length });
    } finally {
      this.backupInProgress = false;
    }
  }

  async restore(): Promise<{ imported: number; skipped: number } | null> {
    if (!existsSync(this.backupPath)) {
      log.info('no backup file found');
      return null;
    }
    const raw = readFileSync(this.backupPath, 'utf-8');
    const data = JSON.parse(raw) as MemoryBackup;
    if (data.version !== 1 && data.version !== 2) {
      log.warn('unsupported backup version', { version: (data as { version: unknown }).version });
      return null;
    }
    if (
      !Array.isArray(data.identity) ||
      !Array.isArray(data.userProfile) ||
      !Array.isArray(data.facts) ||
      !Array.isArray(data.preferences) ||
      !Array.isArray(data.sessionSummaries)
    ) {
      log.warn('malformed backup file — missing or invalid arrays');
      return null;
    }
    const result = await this.store.importMemories(data);
    log.info('backup restored', { ...result, exportedAt: data.exportedAt });
    return result;
  }

  start(): void {
    this.timer.start();
  }

  stop(): void {
    this.timer.stop();
  }

  checkStaleness(): void {
    if (!existsSync(this.backupPath)) {
      log.warn('no memory backup file exists — memories are unprotected');
      return;
    }
    const stat = statSync(this.backupPath);
    const ageMs = Date.now() - stat.mtimeMs;
    if (ageMs > this.staleThresholdMs) {
      log.warn('memory backup is stale', { ageMinutes: Math.round(ageMs / 60_000) });
    }
  }
}
