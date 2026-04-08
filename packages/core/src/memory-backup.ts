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
import type { DataStore, MemoryBackup } from '@neura/types';

const log = new Logger('backup');

export interface BackupServiceOptions {
  store: DataStore;
  backupPath: string;
  intervalMs?: number;
  staleThresholdMs?: number;
}

export interface BackupService {
  backup(): Promise<void>;
  restore(): Promise<{ imported: number; skipped: number } | null>;
  start(): void;
  stop(): void;
  checkStaleness(): void;
  readonly backupPath: string;
}

export function createBackupService(options: BackupServiceOptions): BackupService {
  const { store, backupPath, intervalMs = 5 * 60_000, staleThresholdMs = 60 * 60_000 } = options;
  let timer: ReturnType<typeof setInterval> | null = null;
  let backupInProgress = false;

  async function backup(): Promise<void> {
    if (backupInProgress) return;
    backupInProgress = true;
    try {
      const data = await store.exportMemories();
      const json = JSON.stringify(data, null, 2);
      const tmpPath = backupPath + '.tmp';
      mkdirSync(dirname(backupPath), { recursive: true });
      writeFileSync(tmpPath, json, 'utf-8');
      renameSync(tmpPath, backupPath);
      const totalEntries =
        data.identity.length +
        data.userProfile.length +
        data.facts.length +
        data.preferences.length +
        data.sessionSummaries.length;
      log.info('backup saved', { entries: totalEntries, bytes: json.length });
    } finally {
      backupInProgress = false;
    }
  }

  async function restore(): Promise<{ imported: number; skipped: number } | null> {
    if (!existsSync(backupPath)) {
      log.info('no backup file found');
      return null;
    }
    const raw = readFileSync(backupPath, 'utf-8');
    const data = JSON.parse(raw) as MemoryBackup;
    if (data.version !== 1) {
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
    const result = await store.importMemories(data);
    log.info('backup restored', { ...result, exportedAt: data.exportedAt });
    return result;
  }

  function start(): void {
    if (timer) return;
    timer = setInterval(() => {
      void backup().catch((err) => log.warn('periodic backup failed', { err: String(err) }));
    }, intervalMs);
    timer.unref();
  }

  function stop(): void {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  function checkStaleness(): void {
    if (!existsSync(backupPath)) {
      log.warn('no memory backup file exists — memories are unprotected');
      return;
    }
    const stat = statSync(backupPath);
    const ageMs = Date.now() - stat.mtimeMs;
    if (ageMs > staleThresholdMs) {
      log.warn('memory backup is stale', { ageMinutes: Math.round(ageMs / 60_000) });
    }
  }

  return { backup, restore, start, stop, checkStaleness, backupPath };
}
