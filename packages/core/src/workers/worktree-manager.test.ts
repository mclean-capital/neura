/**
 * Tests for WorktreeManager (Phase 6b Wave 4).
 *
 * Covers the three entry points — create, cleanup, sweepOrphans — plus
 * the git-backed happy path when a real git repo is present. The git
 * test initializes a throwaway repo in a tmpdir so we don't touch the
 * host environment.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorktreeManager } from './worktree-manager.js';

let basePath: string;
let scratchRoot: string;

beforeEach(() => {
  scratchRoot = mkdtempSync(join(tmpdir(), 'neura-wt-root-'));
  basePath = join(scratchRoot, 'worktrees');
});

afterEach(() => {
  if (existsSync(scratchRoot)) {
    rmSync(scratchRoot, { recursive: true, force: true });
  }
});

describe('WorktreeManager.create', () => {
  it('mkdirs a scratch worktree when repoPath is absent', () => {
    const m = new WorktreeManager({ basePath });
    const res = m.create({ workerId: 'w-1' });
    expect(res.gitBacked).toBe(false);
    expect(existsSync(res.path)).toBe(true);
    expect(res.path.endsWith('w-1')).toBe(true);
  });

  it('clobbers a pre-existing dir so the crash-retry path is safe', () => {
    const m = new WorktreeManager({ basePath });
    const path = m.pathFor('w-1');
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, 'stale.txt'), 'old');

    m.create({ workerId: 'w-1' });
    expect(existsSync(join(path, 'stale.txt'))).toBe(false);
  });

  it('falls back to scratch dir when git worktree add fails', () => {
    const m = new WorktreeManager({ basePath });
    const res = m.create({
      workerId: 'w-1',
      repoPath: '/nonexistent/repo-path-12345',
    });
    expect(res.gitBacked).toBe(false);
    expect(existsSync(res.path)).toBe(true);
  });
});

describe('WorktreeManager.cleanup', () => {
  it('removes a scratch worktree', () => {
    const m = new WorktreeManager({ basePath });
    const res = m.create({ workerId: 'w-1' });
    expect(existsSync(res.path)).toBe(true);
    m.cleanup('w-1');
    expect(existsSync(res.path)).toBe(false);
  });

  it('is a no-op on unknown workerId', () => {
    const m = new WorktreeManager({ basePath });
    expect(() => m.cleanup('does-not-exist')).not.toThrow();
  });
});

describe('WorktreeManager.sweepOrphans', () => {
  it('removes directories not in liveWorkerIds when past the retention window', async () => {
    const m = new WorktreeManager({ basePath, retentionHours: 0 });
    m.create({ workerId: 'w-alive' });
    m.create({ workerId: 'w-orphan' });

    // mtime precision is coarse enough (and Date.now() granular enough)
    // that a zero-retention sweep immediately after mkdir can see ageMs
    // rounded to 0. Wait a tick so the orphan is strictly past the zero
    // window.
    await new Promise((r) => setTimeout(r, 10));

    const result = m.sweepOrphans(new Set(['w-alive']));
    expect(result.removed).toBe(1);
    expect(result.kept).toBe(1);
    expect(existsSync(m.pathFor('w-alive'))).toBe(true);
    expect(existsSync(m.pathFor('w-orphan'))).toBe(false);
  });

  it('preserves orphans that are still inside the retention window', () => {
    const m = new WorktreeManager({ basePath, retentionHours: 24 });
    m.create({ workerId: 'fresh-orphan' });
    const result = m.sweepOrphans(new Set());
    expect(result.removed).toBe(0);
    expect(result.kept).toBe(1);
    expect(existsSync(m.pathFor('fresh-orphan'))).toBe(true);
  });

  it('handles missing basePath cleanly', () => {
    // basePath was created by the constructor; remove it to simulate a
    // fresh install that hasn't dispatched any workers yet.
    const m = new WorktreeManager({ basePath });
    rmSync(basePath, { recursive: true, force: true });
    const result = m.sweepOrphans(new Set());
    expect(result.removed).toBe(0);
    expect(result.kept).toBe(0);
  });
});

describe('WorktreeManager — git-backed', () => {
  let repoPath: string;

  beforeEach(() => {
    repoPath = join(scratchRoot, 'fake-repo');
    mkdirSync(repoPath, { recursive: true });
    execFileSync('git', ['init', '--quiet', '--initial-branch=main'], {
      cwd: repoPath,
      stdio: 'pipe',
    });
    // Minimum identity config for commits.
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoPath });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repoPath });
    writeFileSync(join(repoPath, 'README.md'), 'hello');
    execFileSync('git', ['add', '.'], { cwd: repoPath });
    execFileSync('git', ['commit', '--quiet', '-m', 'init'], { cwd: repoPath });
  });

  it('runs git worktree add when repoPath is provided', () => {
    const m = new WorktreeManager({ basePath });
    const res = m.create({ workerId: 'w-git', repoPath });
    expect(res.gitBacked).toBe(true);
    expect(existsSync(res.path)).toBe(true);
    // The README from the base commit should be materialized in the worktree.
    expect(existsSync(join(res.path, 'README.md'))).toBe(true);
  });

  it('uses git worktree remove on cleanup of a git-backed worktree', () => {
    const m = new WorktreeManager({ basePath });
    const res = m.create({ workerId: 'w-git-rm', repoPath });
    expect(res.gitBacked).toBe(true);
    m.cleanup('w-git-rm');
    expect(existsSync(res.path)).toBe(false);
    // The source repo's `git worktree list` should no longer reference it.
    const list = execFileSync('git', ['worktree', 'list'], {
      cwd: repoPath,
      encoding: 'utf-8',
    });
    expect(list).not.toContain('w-git-rm');
  });
});
