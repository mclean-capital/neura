/**
 * Tests for migrations.ts — specifically the upgrade paths that fresh-install
 * test coverage never exercises.
 *
 * The Phase 6b DO $$ BEGIN … END $$ blocks that rewrite the work_items.status
 * CHECK constraint and the ADD COLUMN IF NOT EXISTS statements are dead code
 * paths in any test that starts with `runMigrations(fresh_db)` — those hit
 * the CREATE TABLE IF NOT EXISTS branch which already has the new schema.
 *
 * These tests build a pre-Phase-6b schema manually, THEN run the full
 * migration, THEN assert that the upgrade produced the expected shape.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
import crypto from 'crypto';
import { runMigrations } from './migrations.js';

/**
 * Create a pre-Phase-6b work_items schema. Matches the shape Phase 6 shipped
 * (status enum of 5 values, no goal/context/version/etc. columns).
 */
async function createPre6bSchema(db: PGlite): Promise<void> {
  await db.exec(`
    CREATE TABLE work_items (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'in_progress', 'done', 'cancelled', 'failed')),
      priority TEXT NOT NULL DEFAULT 'medium'
        CHECK (priority IN ('low', 'medium', 'high')),
      due_at TIMESTAMP,
      parent_id TEXT REFERENCES work_items(id) ON DELETE SET NULL,
      source_session_id TEXT,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
      completed_at TIMESTAMP
    )
  `);
}

describe('migrations — Phase 6b upgrade path', () => {
  let db: PGlite;

  beforeEach(async () => {
    db = await PGlite.create({ extensions: { vector } });
    // Seed prerequisite tables that work_items or its upgrade path may
    // reference indirectly (sessions for source_session_id FK on other
    // flows, etc.). We do the minimum necessary to exercise the upgrade.
    await db.exec('CREATE EXTENSION IF NOT EXISTS vector');
  });

  afterEach(async () => {
    await db.close();
  });

  it('upgrades an existing pre-Phase-6b work_items table to the new schema', async () => {
    await createPre6bSchema(db);

    // Seed a legacy row to prove existing data survives the upgrade.
    const legacyId = crypto.randomUUID();
    await db.query(`INSERT INTO work_items (id, title, priority, status) VALUES ($1, $2, $3, $4)`, [
      legacyId,
      'Legacy task',
      'medium',
      'in_progress',
    ]);

    // Run the real migration. This is what a user upgrading from v3.4.x hits.
    await runMigrations(db);

    // Assertion 1: all new Phase 6b columns exist.
    const columns = await db.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'work_items' ORDER BY column_name`
    );
    const colNames = columns.rows.map((r) => r.column_name);
    for (const expected of [
      'goal',
      'context',
      'related_skills',
      'repo_path',
      'base_branch',
      'worker_id',
      'source',
      'version',
      'lease_expires_at',
    ]) {
      expect(colNames).toContain(expected);
    }

    // Assertion 2: CHECK constraint was rewritten to accept new statuses.
    const constraint = await db.query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def
       FROM pg_constraint WHERE conname = 'work_items_status_check'`
    );
    expect(constraint.rows[0]?.def ?? '').toContain('awaiting_clarification');
    expect(constraint.rows[0]?.def ?? '').toContain('awaiting_approval');
    expect(constraint.rows[0]?.def ?? '').toContain('paused');

    // Assertion 3: a legacy row still exists and has sensible defaults for
    // the new columns (NULL where nullable, '[]' for related_skills, 0 for
    // version, 'user' for source).
    const legacy = await db.query<{
      goal: string | null;
      related_skills: string[];
      source: string;
      version: number;
    }>(`SELECT goal, related_skills, source, version FROM work_items WHERE id = $1`, [legacyId]);
    expect(legacy.rows[0].goal).toBeNull();
    expect(legacy.rows[0].related_skills).toEqual([]);
    expect(legacy.rows[0].source).toBe('user');
    expect(legacy.rows[0].version).toBe(0);

    // Assertion 4: inserting a row with a new-only status value succeeds
    // (proving the constraint was actually replaced, not just aliased).
    const newId = crypto.randomUUID();
    await db.query(`INSERT INTO work_items (id, title, priority, status) VALUES ($1, $2, $3, $4)`, [
      newId,
      'New-status task',
      'medium',
      'awaiting_clarification',
    ]);
    const inserted = await db.query<{ status: string }>(
      `SELECT status FROM work_items WHERE id = $1`,
      [newId]
    );
    expect(inserted.rows[0].status).toBe('awaiting_clarification');
  });

  it('self-heals if the status constraint is missing (crash-between-DROP-and-ADD)', async () => {
    // Build a pre-6b schema, then manually drop the constraint to simulate
    // a crash that killed the migration after DROP but before ADD. Re-running
    // the migration should re-add the new constraint.
    await createPre6bSchema(db);
    await db.exec('ALTER TABLE work_items DROP CONSTRAINT work_items_status_check');

    await runMigrations(db);

    const constraint = await db.query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def
       FROM pg_constraint WHERE conname = 'work_items_status_check'`
    );
    expect(constraint.rows).toHaveLength(1);
    expect(constraint.rows[0].def).toContain('awaiting_clarification');
  });

  it('is idempotent — re-running migrations on an already-6b schema is a no-op', async () => {
    // First run creates fresh schema.
    await runMigrations(db);

    // Seed a row.
    const id = crypto.randomUUID();
    await db.query(`INSERT INTO work_items (id, title, priority) VALUES ($1, $2, $3)`, [
      id,
      'Idempotency test',
      'medium',
    ]);

    // Second + third runs must not error or alter existing rows.
    await runMigrations(db);
    await runMigrations(db);

    // Row is still there, version is still 0, constraint still has the
    // expected shape.
    const row = await db.query<{ version: number; title: string }>(
      `SELECT version, title FROM work_items WHERE id = $1`,
      [id]
    );
    expect(row.rows[0].title).toBe('Idempotency test');
    expect(row.rows[0].version).toBe(0);

    // Only one status-check constraint exists — no duplicates.
    const dupes = await db.query<{ count: string }>(
      `SELECT COUNT(*)::TEXT AS count FROM pg_constraint
       WHERE conname = 'work_items_status_check'`
    );
    expect(dupes.rows[0].count).toBe('1');
  });

  it('creates task_comments table on upgrade from pre-6b schema', async () => {
    await createPre6bSchema(db);
    await runMigrations(db);

    const tables = await db.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = 'task_comments'`
    );
    expect(tables.rows).toHaveLength(1);

    // Verify an insert respecting FK CASCADE works end-to-end.
    const taskId = crypto.randomUUID();
    await db.query(`INSERT INTO work_items (id, title, priority) VALUES ($1, $2, $3)`, [
      taskId,
      'Anchor task',
      'medium',
    ]);

    const commentId = crypto.randomUUID();
    await db.query(
      `INSERT INTO task_comments (id, task_id, type, author, content)
       VALUES ($1, $2, $3, $4, $5)`,
      [commentId, taskId, 'progress', 'worker:1', 'body']
    );

    await db.query(`DELETE FROM work_items WHERE id = $1`, [taskId]);
    const orphan = await db.query<{ count: string }>(
      `SELECT COUNT(*)::TEXT AS count FROM task_comments WHERE id = $1`,
      [commentId]
    );
    expect(orphan.rows[0].count).toBe('0');
  });
});
