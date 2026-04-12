/**
 * Tests for skill-watcher.ts.
 *
 * NOTE: these tests deliberately avoid relying on chokidar's filesystem
 * event delivery. Chokidar's events are unreliable inside vitest's worker
 * threads on macOS (fsevents binding does not work across the thread
 * boundary, and polling-mode delivery is starved by the test runner). The
 * end-to-end chokidar integration was verified via a tsx debug script
 * (see debug/skill-watcher-*.mjs in commit history) and via Spike #4d
 * for the underlying loadSkills() call. What we unit-test here is the
 * reload pipeline: `reloadNow()` triggers loadSkills, the registry is
 * updated, onReload fires, and stop() shuts down cleanly.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SkillRegistry } from './skill-registry.js';
import { SkillWatcher } from './skill-watcher.js';

function makeSkillFile(dir: string, name: string): string {
  const skillDir = join(dir, name);
  mkdirSync(skillDir, { recursive: true });
  const skillPath = join(skillDir, 'SKILL.md');
  writeFileSync(
    skillPath,
    `---
name: ${name}
description: A test skill called ${name} with a long enough description to pass Agent Skills validation rules.
allowed-tools: get_current_time
---

# ${name}

Test skill body.
`
  );
  return skillPath;
}

describe('SkillWatcher', () => {
  let tempRoot: string;
  let cwd: string;
  let repoLocalDir: string;
  let hermeticGlobal: string;
  let registry: SkillRegistry;
  let watcher: SkillWatcher;

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), 'neura-skill-watcher-'));
    cwd = tempRoot;
    repoLocalDir = join(cwd, '.neura', 'skills');
    mkdirSync(repoLocalDir, { recursive: true });
    hermeticGlobal = join(tempRoot, '_nonexistent_global');

    registry = new SkillRegistry();
    watcher = new SkillWatcher({
      registry,
      cwd,
      globalSkillsDir: hermeticGlobal,
    });
  });

  afterEach(async () => {
    await watcher.stop();
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it('performs an initial load on start()', async () => {
    makeSkillFile(repoLocalDir, 'alpha');
    await watcher.start();
    expect(registry.has('alpha')).toBe(true);
    expect(registry.size).toBe(1);
  });

  it('initial load picks up multiple skills', async () => {
    makeSkillFile(repoLocalDir, 'alpha');
    makeSkillFile(repoLocalDir, 'beta');
    await watcher.start();
    expect(registry.size).toBe(2);
    expect(registry.has('alpha')).toBe(true);
    expect(registry.has('beta')).toBe(true);
  });

  it('reloadNow() picks up a newly-added skill', async () => {
    makeSkillFile(repoLocalDir, 'alpha');
    await watcher.start();
    expect(registry.size).toBe(1);

    makeSkillFile(repoLocalDir, 'beta');
    watcher.reloadNow();
    expect(registry.size).toBe(2);
    expect(registry.has('beta')).toBe(true);
  });

  it('reloadNow() picks up a deleted skill', async () => {
    makeSkillFile(repoLocalDir, 'alpha');
    makeSkillFile(repoLocalDir, 'beta');
    await watcher.start();
    expect(registry.size).toBe(2);

    rmSync(join(repoLocalDir, 'alpha'), { recursive: true, force: true });
    watcher.reloadNow();
    expect(registry.size).toBe(1);
    expect(registry.has('alpha')).toBe(false);
    expect(registry.has('beta')).toBe(true);
  });

  it('reloadNow() picks up a modified skill', async () => {
    makeSkillFile(repoLocalDir, 'alpha');
    await watcher.start();
    expect(registry.get('alpha')?.description).toContain('test skill called alpha');

    // Rewrite the SKILL.md with a new description.
    writeFileSync(
      join(repoLocalDir, 'alpha', 'SKILL.md'),
      `---
name: alpha
description: This is the freshly rewritten description for alpha which still needs to be long enough.
allowed-tools: get_current_time
---

# alpha

Rewritten body.
`
    );
    watcher.reloadNow();
    expect(registry.get('alpha')?.description).toContain('freshly rewritten');
  });

  it('fires onReload callback with skill count and diagnostics', async () => {
    const reloads: { skillCount: number; diagCount: number }[] = [];
    const localWatcher = new SkillWatcher({
      registry: new SkillRegistry(),
      cwd,
      globalSkillsDir: hermeticGlobal,
      onReload: (info) =>
        reloads.push({
          skillCount: info.skillCount,
          diagCount: info.diagnostics.length,
        }),
    });

    try {
      makeSkillFile(repoLocalDir, 'alpha');
      await localWatcher.start();
      // Initial load fired onReload exactly once with skill count 1.
      expect(reloads.length).toBeGreaterThanOrEqual(1);
      expect(reloads.at(-1)?.skillCount).toBe(1);

      makeSkillFile(repoLocalDir, 'beta');
      localWatcher.reloadNow();
      expect(reloads.at(-1)?.skillCount).toBe(2);
    } finally {
      await localWatcher.stop();
    }
  });

  it('reloadNow() is safe to call before start()', () => {
    // Create a fresh watcher that hasn't started yet. reloadNow() should
    // still load from disk without throwing — it's useful for test setups
    // and for tool handlers that want to bootstrap the registry eagerly.
    const freshRegistry = new SkillRegistry();
    const freshWatcher = new SkillWatcher({
      registry: freshRegistry,
      cwd,
      globalSkillsDir: hermeticGlobal,
    });
    makeSkillFile(repoLocalDir, 'alpha');
    freshWatcher.reloadNow();
    expect(freshRegistry.has('alpha')).toBe(true);
    // Don't start, so we don't need to stop — the watcher has no resources
    // attached yet.
  });

  it('stop() is idempotent', async () => {
    await watcher.start();
    await watcher.stop();
    await watcher.stop();
    expect(true).toBe(true);
  });

  it('updates the registry on successive reloadNow() calls', async () => {
    makeSkillFile(repoLocalDir, 'alpha');
    await watcher.start();
    expect(registry.size).toBe(1);

    // Add a skill and reload.
    makeSkillFile(repoLocalDir, 'beta');
    watcher.reloadNow();
    expect(registry.size).toBe(2);

    // Add another and reload again.
    makeSkillFile(repoLocalDir, 'gamma');
    watcher.reloadNow();
    expect(registry.size).toBe(3);

    // Delete one and reload.
    rmSync(join(repoLocalDir, 'beta'), { recursive: true, force: true });
    watcher.reloadNow();
    expect(registry.size).toBe(2);
    expect(registry.has('beta')).toBe(false);
  });
});
