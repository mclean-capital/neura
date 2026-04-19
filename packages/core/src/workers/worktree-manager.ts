/**
 * Phase 6b Wave 4 — Worktree manager.
 *
 * Owns the `~/.neura/worktrees/<workerId>/` directory tree:
 *
 *   1. `create({ workerId, repoPath?, baseBranch? })` — when `repoPath` is
 *      set, runs `git worktree add <dest> <branch>` so the worker has a
 *      real working tree of the user repo on its own branch. Otherwise
 *      just mkdirs a plain scratch sandbox. Returns the absolute path of
 *      the resulting worktree.
 *
 *   2. `cleanup(workerId, { gitRepoPath? })` — removes the worktree. Uses
 *      `git worktree remove --force` when the original add was git-backed
 *      (so the source repo's internal pointers stay consistent); falls
 *      back to plain `rm -rf` otherwise.
 *
 *   3. `sweepOrphans(liveWorkerIds)` — at core startup, every directory
 *      under the base path that isn't backed by a known live worker row
 *      is swept. Catches worktrees orphaned by crashes.
 *
 * The full mitigation matrix (submodules, LFS, disk cap, Windows MAX_PATH,
 * concurrent-add) from plan §Worktree risks is only partially covered:
 *
 *   - Basic git worktree add lands here (✓).
 *   - Submodule init, LFS hydration, copy_paths: skipped — wire them when
 *     we encounter user repos that actually need them.
 *   - Disk cap enforcement (`worktreeMaxTotalBytes`): skipped — add when
 *     concurrent workers in a real environment start filling disk.
 *   - Orphan sweep at startup (✓).
 *   - Retention window (`worktreeRetentionHours`): the manager exposes
 *     a retention-aware cleanup. AgentWorker schedules it on terminal.
 *
 * Errors from `git worktree add/remove` are logged but don't throw back
 * up the call chain — a broken worktree is a degraded worker, not a
 * dispatched-worker crash. The worker gets a plain mkdir fallback when
 * git add fails so it can at least run in a scratch sandbox.
 */

import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { Logger } from '@neura/utils/logger';

const log = new Logger('worktree-manager');

const DEFAULT_RETENTION_HOURS = 24;

export interface WorktreeManagerOptions {
  /**
   * Base directory for per-worker worktrees. Defaults to
   * `~/.neura/worktrees`.
   */
  basePath?: string;

  /** Retention window for failed / cancelled worktrees before sweep. */
  retentionHours?: number;
}

export interface CreateWorktreeArgs {
  workerId: string;
  /** Absolute path to a user repo. When set, runs `git worktree add`. */
  repoPath?: string | null;
  /** Branch name to base the worktree on. Defaults to HEAD. */
  baseBranch?: string | null;
}

export interface CreateWorktreeResult {
  /** Absolute path to the worktree directory. */
  path: string;
  /** True when `git worktree add` succeeded. False for scratch mkdir. */
  gitBacked: boolean;
  /** Source repo path (only set when gitBacked is true). */
  sourceRepoPath?: string;
}

export class WorktreeManager {
  private readonly basePath: string;
  private readonly retentionMs: number;
  /**
   * Tracks which worktrees came from `git worktree add` so `cleanup` can
   * use `git worktree remove --force` on them. Keyed by workerId. Not
   * persisted — on core restart the orphan sweep handles leftover
   * directories; we don't need to round-trip git-backed-ness through
   * state because sweep nukes everything unclaimed anyway.
   */
  private readonly gitBacked = new Map<string, string>();

  constructor(opts: WorktreeManagerOptions = {}) {
    this.basePath = opts.basePath ?? join(homedir(), '.neura', 'worktrees');
    this.retentionMs = (opts.retentionHours ?? DEFAULT_RETENTION_HOURS) * 3_600_000;
    mkdirSync(this.basePath, { recursive: true });
  }

  /** Absolute path where this worker's worktree lives (may not exist yet). */
  pathFor(workerId: string): string {
    return resolve(this.basePath, workerId);
  }

  /**
   * Create a per-worker worktree. Returns the absolute path even if git
   * add fails (callers can still run the worker in the fallback scratch
   * dir rather than blocking dispatch on worktree construction).
   */
  create(args: CreateWorktreeArgs): CreateWorktreeResult {
    const dest = this.pathFor(args.workerId);

    // If the dir already exists (crash + retry), remove it first so
    // `git worktree add` doesn't complain about a pre-existing path.
    if (existsSync(dest)) {
      log.warn('worktree dir already exists; removing before create', {
        workerId: args.workerId,
        dest,
      });
      rmSync(dest, { recursive: true, force: true });
    }

    if (args.repoPath) {
      try {
        // `git worktree add <dest> <branch>` fails with
        //   fatal: '<branch>' is already used by worktree at …
        // whenever the source repo has that branch checked out in its
        // main worktree — the overwhelmingly common case for values
        // like `main` / `master`. Creating a per-worker branch via
        // `-b neura/worker/<id>` sidesteps the collision and gives the
        // worker an isolated ref it can commit against without
        // polluting the source repo's branches.
        const workerBranch = `neura/worker/${args.workerId}`;
        const gitArgs = ['worktree', 'add', '-b', workerBranch, dest];
        if (args.baseBranch) gitArgs.push(args.baseBranch);
        execFileSync('git', gitArgs, { cwd: args.repoPath, stdio: 'pipe' });
        this.gitBacked.set(args.workerId, args.repoPath);
        // Drop a marker inside the worktree so the startup sweep can
        // find the source repo to run `git worktree prune` on even
        // when the in-memory `gitBacked` map was lost to a crash.
        try {
          writeFileSync(
            join(dest, '.neura-source-repo'),
            JSON.stringify({ repoPath: args.repoPath, branch: workerBranch }) + '\n'
          );
        } catch (markerErr) {
          log.warn('failed to write worktree source-repo marker', {
            workerId: args.workerId,
            err: String(markerErr),
          });
        }
        log.info('git worktree added', {
          workerId: args.workerId,
          dest,
          repoPath: args.repoPath,
          baseBranch: args.baseBranch ?? 'HEAD',
          workerBranch,
        });
        return { path: dest, gitBacked: true, sourceRepoPath: args.repoPath };
      } catch (err) {
        log.warn('git worktree add failed; falling back to scratch dir', {
          workerId: args.workerId,
          repoPath: args.repoPath,
          err: String(err),
        });
        mkdirSync(dest, { recursive: true });
        return { path: dest, gitBacked: false };
      }
    }

    mkdirSync(dest, { recursive: true });
    return { path: dest, gitBacked: false };
  }

  /**
   * Remove a worktree. Safe on unknown / already-gone workerIds.
   */
  cleanup(workerId: string): void {
    const dest = this.pathFor(workerId);
    if (!existsSync(dest)) {
      this.gitBacked.delete(workerId);
      return;
    }
    const sourceRepo = this.gitBacked.get(workerId);
    if (sourceRepo) {
      try {
        execFileSync('git', ['worktree', 'remove', '--force', dest], {
          cwd: sourceRepo,
          stdio: 'pipe',
        });
        log.info('git worktree removed', { workerId, dest });
      } catch (err) {
        log.warn('git worktree remove failed; falling back to rm -rf', {
          workerId,
          err: String(err),
        });
        rmSync(dest, { recursive: true, force: true });
      }
      this.gitBacked.delete(workerId);
    } else {
      rmSync(dest, { recursive: true, force: true });
      log.info('scratch worktree removed', { workerId, dest });
    }
  }

  /**
   * Schedule cleanup after the retention window elapses. Used for
   * failed / cancelled workers — the worktree is kept around in case the
   * operator wants to inspect what went wrong, then swept. `done`
   * dispatches clean up immediately via `cleanup()` and don't need this.
   */
  scheduleCleanup(workerId: string): void {
    const timer = setTimeout(() => {
      try {
        this.cleanup(workerId);
      } catch (err) {
        log.warn('scheduled cleanup failed', { workerId, err: String(err) });
      }
    }, this.retentionMs);
    // Don't hold the process open just to wait out the retention window.
    timer.unref();
  }

  /**
   * Sweep orphans at startup. Any directory under basePath that isn't in
   * `liveWorkerIds` is removed. Directories whose mtime is newer than
   * the retention window are kept (they may be in-flight from a
   * concurrent core or the operator hand-created something — safer to
   * leave and log).
   *
   * Git-backed worktrees are detected via the `.neura-source-repo`
   * marker dropped on create. When present, we run
   * `git worktree prune` in the source repo before `rmSync` so the
   * repo's `.git/worktrees/<id>/` metadata is cleaned up too. Without
   * this the source repo accumulates stale pointers and eventually
   * refuses new `git worktree add` calls.
   */
  sweepOrphans(liveWorkerIds: ReadonlySet<string>): { removed: number; kept: number } {
    if (!existsSync(this.basePath)) return { removed: 0, kept: 0 };
    let removed = 0;
    let kept = 0;
    for (const entry of readdirSync(this.basePath)) {
      if (liveWorkerIds.has(entry)) {
        kept++;
        continue;
      }
      const full = join(this.basePath, entry);
      let stat;
      try {
        stat = statSync(full);
      } catch {
        continue;
      }
      const ageMs = Date.now() - stat.mtimeMs;
      if (ageMs < this.retentionMs) {
        log.info('worktree orphan within retention window; keeping', {
          path: full,
          ageHours: (ageMs / 3_600_000).toFixed(1),
        });
        kept++;
        continue;
      }
      // Look for the git-backed marker we wrote on create.
      const markerPath = join(full, '.neura-source-repo');
      if (existsSync(markerPath)) {
        try {
          const marker = JSON.parse(readFileSync(markerPath, 'utf8')) as {
            repoPath: string;
            branch?: string;
          };
          if (marker.repoPath) {
            try {
              execFileSync('git', ['worktree', 'remove', '--force', full], {
                cwd: marker.repoPath,
                stdio: 'pipe',
              });
              log.info('orphan git worktree removed via git', {
                path: full,
                repoPath: marker.repoPath,
              });
              removed++;
              continue;
            } catch (gitErr) {
              log.warn('git worktree remove failed for orphan; falling through to rm', {
                path: full,
                repoPath: marker.repoPath,
                err: String(gitErr),
              });
              // Fall through — we still want to rm the dir. Then try
              // `git worktree prune` so the stale admin entry drops.
              try {
                rmSync(full, { recursive: true, force: true });
              } catch {
                // continue to prune below regardless
              }
              try {
                execFileSync('git', ['worktree', 'prune'], {
                  cwd: marker.repoPath,
                  stdio: 'pipe',
                });
              } catch {
                // best-effort; nothing to do if prune fails
              }
              removed++;
              continue;
            }
          }
        } catch (err) {
          log.warn('worktree marker parse failed; falling back to rm -rf', {
            path: full,
            err: String(err),
          });
        }
      }
      try {
        rmSync(full, { recursive: true, force: true });
        log.info('orphan scratch worktree removed', { path: full });
        removed++;
      } catch (err) {
        log.warn('orphan worktree remove failed', { path: full, err: String(err) });
      }
    }
    return { removed, kept };
  }
}
