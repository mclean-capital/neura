import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { PgliteStore } from './stores/pglite-store.js';
import { createBackupService } from './memory-backup.js';

let store: PgliteStore;
let tmpDir: string;
let backupPath: string;

beforeEach(async () => {
  store = await PgliteStore.create(); // in-memory
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'neura-backup-test-'));
  backupPath = path.join(tmpDir, 'memory-backup.json');
});

afterEach(async () => {
  await store.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('BackupService', () => {
  it('creates a valid backup file', async () => {
    await store.upsertFact('Test fact', 'general', ['test']);

    const service = createBackupService({ store, backupPath });
    await service.backup();

    expect(fs.existsSync(backupPath)).toBe(true);
    const data = JSON.parse(fs.readFileSync(backupPath, 'utf-8'));
    expect(data.version).toBe(1);
    expect(data.exportedAt).toBeTruthy();
    expect(data.facts).toHaveLength(1);
    expect(data.facts[0].content).toBe('Test fact');
  });

  it('restores from backup into a fresh store', async () => {
    await store.upsertFact('Backed up fact', 'technical', ['backup']);
    await store.upsertPreference('Be brief', 'response_style');

    const service = createBackupService({ store, backupPath });
    await service.backup();
    await store.close();

    // Fresh store
    const store2 = await PgliteStore.create();
    const service2 = createBackupService({ store: store2, backupPath });
    const result = await service2.restore();

    expect(result).not.toBeNull();
    expect(result!.imported).toBeGreaterThan(0);

    const facts = await store2.getFacts();
    expect(facts.some((f) => f.content === 'Backed up fact')).toBe(true);

    const prefs = await store2.getPreferences();
    expect(prefs.some((p) => p.preference === 'Be brief')).toBe(true);

    // Reassign for afterEach cleanup
    store = store2;
  });

  it('returns null when no backup file exists', async () => {
    const service = createBackupService({ store, backupPath });
    const result = await service.restore();
    expect(result).toBeNull();
  });

  it('returns null for malformed backup file', async () => {
    fs.writeFileSync(backupPath, JSON.stringify({ version: 1, identity: 'not-an-array' }));

    const service = createBackupService({ store, backupPath });
    const result = await service.restore();
    expect(result).toBeNull();
  });

  it('returns null for unsupported version', async () => {
    fs.writeFileSync(backupPath, JSON.stringify({ version: 99 }));

    const service = createBackupService({ store, backupPath });
    const result = await service.restore();
    expect(result).toBeNull();
  });

  it('atomic write does not corrupt existing backup on error', async () => {
    await store.upsertFact('Original fact', 'general', []);

    const service = createBackupService({ store, backupPath });
    await service.backup();

    // Verify original backup is valid
    const original = JSON.parse(fs.readFileSync(backupPath, 'utf-8'));
    expect(original.facts[0].content).toBe('Original fact');

    // Tmp file should be cleaned up
    expect(fs.existsSync(backupPath + '.tmp')).toBe(false);
  });

  it('start/stop controls periodic timer', async () => {
    const service = createBackupService({ store, backupPath, intervalMs: 100 });
    service.start();

    // Wait for at least one backup cycle
    await new Promise((r) => setTimeout(r, 250));
    service.stop();

    expect(fs.existsSync(backupPath)).toBe(true);
  });

  it('concurrent backup guard prevents overlapping backups', async () => {
    const service = createBackupService({ store, backupPath });

    // Fire two backups concurrently
    const [r1, r2] = await Promise.all([service.backup(), service.backup()]);

    // Both resolve (second one is a no-op), file exists
    expect(r1).toBeUndefined();
    expect(r2).toBeUndefined();
    expect(fs.existsSync(backupPath)).toBe(true);
  });
});
