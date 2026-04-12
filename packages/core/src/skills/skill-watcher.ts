/**
 * Phase 6 — Skill watcher
 *
 * Watches the three canonical skill locations (repo-local, global, and any
 * explicit paths) via chokidar and triggers a full re-load through the
 * shared `loadNeuraSkills()` path on any change. Hot-reload is coarse on
 * purpose: pi's loader is fast (~7ms for a handful of skills per Spike #4d)
 * and a full reload keeps the shadow-resolution rules honest without the
 * registry having to reason about partial updates.
 *
 * Changes are debounced so a single logical edit (save + backup file +
 * linter touch) doesn't trigger a burst of reloads.
 */

import { homedir } from 'node:os';
import { resolve } from 'node:path';
import chokidar, { type FSWatcher } from 'chokidar';
import { Logger } from '@neura/utils/logger';
import type { SkillDiagnostic } from '@neura/types';
import { loadNeuraSkills } from './skill-loader.js';
import type { SkillRegistry } from './skill-registry.js';

const log = new Logger('skill-watcher');

export interface SkillWatcherOptions {
  /** Registry to update on every reload. */
  registry: SkillRegistry;

  /** cwd for resolving `./.neura/skills/`. Default: `process.cwd()`. */
  cwd?: string;

  /** Override for the global skill directory. Default: `~/.neura/skills`. */
  globalSkillsDir?: string;

  /** Extra skill paths to watch in addition to the defaults. */
  explicitPaths?: string[];

  /**
   * Debounce window for reloads. Multiple filesystem events arriving inside
   * this window collapse into a single reload. Default: 200ms.
   */
  debounceMs?: number;

  /**
   * Optional callback fired after each successful reload — useful for
   * surfacing diagnostics to the CLI or logs. Not fired on errors.
   */
  onReload?: (info: { skillCount: number; diagnostics: SkillDiagnostic[] }) => void;
}

export class SkillWatcher {
  private readonly registry: SkillRegistry;
  private readonly cwd: string;
  private readonly globalSkillsDir: string;
  private readonly explicitPaths: string[];
  private readonly debounceMs: number;
  private readonly onReload?: (info: {
    skillCount: number;
    diagnostics: SkillDiagnostic[];
  }) => void;

  private watcher: FSWatcher | null = null;
  private debounceTimer: NodeJS.Timeout | null = null;
  private reloading = false;
  private reloadAgain = false;

  constructor(options: SkillWatcherOptions) {
    this.registry = options.registry;
    this.cwd = options.cwd ?? process.cwd();
    this.globalSkillsDir = options.globalSkillsDir ?? resolve(homedir(), '.neura', 'skills');
    this.explicitPaths = options.explicitPaths ?? [];
    this.debounceMs = options.debounceMs ?? 200;
    this.onReload = options.onReload;
  }

  /**
   * Start watching + do an initial load. Must be called before the watcher
   * is useful. Safe to call multiple times — subsequent calls are a no-op.
   */
  async start(): Promise<void> {
    if (this.watcher) return;

    // Initial load — populate the registry synchronously so the first Grok
    // turn sees skills without waiting for a filesystem event.
    this.reload();

    const repoLocal = resolve(this.cwd, '.neura', 'skills');
    const paths = [repoLocal, this.globalSkillsDir, ...this.explicitPaths];

    log.info('starting skill watcher', { paths, debounceMs: this.debounceMs });

    this.watcher = chokidar.watch(paths, {
      ignoreInitial: true, // initial load already happened via reload()
      persistent: true,
      // Filter out garbage: editor backup files, macOS metadata, etc.
      // We do NOT use awaitWriteFinish because it delays delete-event
      // detection and provides limited value here — the debounce window
      // we apply in scheduleReload() already coalesces rapid bursts of
      // events from a single logical edit.
      ignored: (path: string) => {
        if (path.includes('.DS_Store')) return true;
        if (path.endsWith('~')) return true;
        return false;
      },
    });

    this.watcher.on('add', (path) => this.scheduleReload('add', path));
    this.watcher.on('change', (path) => this.scheduleReload('change', path));
    this.watcher.on('unlink', (path) => this.scheduleReload('unlink', path));
    this.watcher.on('addDir', (path) => this.scheduleReload('addDir', path));
    this.watcher.on('unlinkDir', (path) => this.scheduleReload('unlinkDir', path));
    this.watcher.on('error', (err) => log.error('chokidar error', { err: String(err) }));

    await new Promise<void>((resolveReady) => {
      if (!this.watcher) return resolveReady();
      this.watcher.once('ready', () => resolveReady());
    });

    log.info('skill watcher ready');
  }

  /**
   * Stop watching and release file handles. Idempotent.
   */
  async stop(): Promise<void> {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
  }

  /**
   * Force an immediate reload, bypassing the debounce window. Useful for
   * tests and for tool handlers that know a change just landed (e.g. the
   * `create_skill` tool calling this synchronously after writing the file).
   */
  reloadNow(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    this.reload();
  }

  private scheduleReload(event: string, path: string): void {
    log.info('skill file event', { event, path });
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.reload();
    }, this.debounceMs);
  }

  /**
   * Reload the entire skill registry from disk. If a reload is already in
   * progress, defer and coalesce — at most one extra reload is queued.
   */
  private reload(): void {
    if (this.reloading) {
      this.reloadAgain = true;
      return;
    }
    this.reloading = true;
    try {
      const result = loadNeuraSkills({
        cwd: this.cwd,
        globalSkillsDir: this.globalSkillsDir,
        explicitPaths: this.explicitPaths,
      });
      this.registry.replaceAll(result.skills);
      if (result.diagnostics.length > 0) {
        log.info('skill load diagnostics', {
          diagnosticCount: result.diagnostics.length,
        });
        for (const diag of result.diagnostics) {
          if (diag.type === 'error') {
            log.error('skill diagnostic', { message: diag.message, path: diag.path });
          } else {
            log.warn('skill diagnostic', { message: diag.message, path: diag.path });
          }
        }
      }
      if (this.onReload) {
        try {
          this.onReload({
            skillCount: result.skills.length,
            diagnostics: result.diagnostics,
          });
        } catch (err) {
          log.warn('onReload listener threw', { err: String(err) });
        }
      }
    } catch (err) {
      log.error('skill reload failed', { err: String(err) });
    } finally {
      this.reloading = false;
      if (this.reloadAgain) {
        this.reloadAgain = false;
        // Schedule the queued reload on the next microtask so we don't
        // recurse synchronously.
        queueMicrotask(() => this.reload());
      }
    }
  }
}
