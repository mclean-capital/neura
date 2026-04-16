/**
 * Tests for skill-loader.ts.
 *
 * Uses co-located fixtures at __fixtures__/.neura/skills/ (copied from the
 * Spike #4d fixture set). The fixtures cover both a normal skill
 * (`hello-world`) and a draft skill (`draft-skill` with
 * `disable-model-invocation: true`).
 */

import { describe, it, expect } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Skill as PiSkill } from '@mariozechner/pi-coding-agent';
import { loadNeuraSkills, toNeuraSkill, MINIMAL_DEFAULT_ALLOWED_TOOLS } from './skill-loader.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixtureCwd = resolve(__dirname, '__fixtures__');
// Point global at a non-existent directory so the test is hermetic — we only
// want the fixture's repo-local skills to load.
const hermeticGlobal = resolve(__dirname, '__fixtures__', '_nonexistent_global');

describe('loadNeuraSkills', () => {
  it('loads skills from ./.neura/skills (repo-local highest priority)', () => {
    const result = loadNeuraSkills({
      cwd: fixtureCwd,
      globalSkillsDir: hermeticGlobal,
    });

    expect(result.skills).toHaveLength(3);

    const helloWorld = result.skills.find((s) => s.name === 'hello-world');
    const draftSkill = result.skills.find((s) => s.name === 'draft-skill');
    const overCompat = result.skills.find((s) => s.name === 'over-compat-skill');

    expect(helloWorld).toBeDefined();
    expect(draftSkill).toBeDefined();
    expect(overCompat).toBeDefined();

    // All fixtures live under the repo-local path for this test.
    expect(helloWorld?.location).toBe('repo-local');
    expect(draftSkill?.location).toBe('repo-local');
    expect(overCompat?.location).toBe('repo-local');
  });

  it('extracts allowed-tools from frontmatter (pi does not surface this)', () => {
    const result = loadNeuraSkills({
      cwd: fixtureCwd,
      globalSkillsDir: hermeticGlobal,
    });

    const helloWorld = result.skills.find((s) => s.name === 'hello-world');
    expect(helloWorld?.hasExplicitAllowedTools).toBe(true);
    expect(helloWorld?.allowedTools).toEqual(['describe_screen', 'create_task']);
  });

  it('extracts metadata.* nested fields from frontmatter', () => {
    const result = loadNeuraSkills({
      cwd: fixtureCwd,
      globalSkillsDir: hermeticGlobal,
    });

    const helloWorld = result.skills.find((s) => s.name === 'hello-world');
    expect(helloWorld?.metadata).toMatchObject({
      neura_source: 'manual',
    });
  });

  it('exposes disable-model-invocation from pi (draft skills)', () => {
    const result = loadNeuraSkills({
      cwd: fixtureCwd,
      globalSkillsDir: hermeticGlobal,
    });

    const helloWorld = result.skills.find((s) => s.name === 'hello-world');
    const draftSkill = result.skills.find((s) => s.name === 'draft-skill');

    expect(helloWorld?.disableModelInvocation).toBe(false);
    expect(draftSkill?.disableModelInvocation).toBe(true);
  });

  it('does NOT emit an allowed-tools absence warning for skills that declare the field', () => {
    const result = loadNeuraSkills({
      cwd: fixtureCwd,
      globalSkillsDir: hermeticGlobal,
    });

    // Both fixture skills declare allowed-tools, so there should be no
    // absence warnings for either.
    const absenceWarnings = result.diagnostics.filter((d) =>
      d.message.includes("no 'allowed-tools' field")
    );
    expect(absenceWarnings).toHaveLength(0);
  });

  it('extracts license + compatibility from frontmatter (agentskills.io spec)', () => {
    const result = loadNeuraSkills({
      cwd: fixtureCwd,
      globalSkillsDir: hermeticGlobal,
    });

    const helloWorld = result.skills.find((s) => s.name === 'hello-world');
    expect(helloWorld?.license).toBe('MIT');
    expect(helloWorld?.compatibility).toBe(
      'Designed for Neura core (or any agentskills.io-compatible runtime)'
    );

    // draft-skill declares neither — both should be undefined.
    const draftSkill = result.skills.find((s) => s.name === 'draft-skill');
    expect(draftSkill?.license).toBeUndefined();
    expect(draftSkill?.compatibility).toBeUndefined();
  });

  it('emits warning diagnostic when compatibility exceeds the 500-char spec cap', () => {
    const result = loadNeuraSkills({
      cwd: fixtureCwd,
      globalSkillsDir: hermeticGlobal,
    });

    const overLength = result.diagnostics.find(
      (d) => d.type === 'warning' && d.message.includes("Skill 'over-compat-skill'")
    );
    expect(overLength).toBeDefined();
    expect(overLength?.message).toContain('500');

    // Skill should still load — diagnostics are non-fatal.
    const overCompat = result.skills.find((s) => s.name === 'over-compat-skill');
    expect(overCompat).toBeDefined();
  });

  it('MINIMAL_DEFAULT_ALLOWED_TOOLS is the documented read-only set', () => {
    // This is both documentation and a regression guard — if we ever change
    // the default, a test failure forces us to update the design doc too.
    expect(MINIMAL_DEFAULT_ALLOWED_TOOLS).toEqual([
      'list_skills',
      'recall_memory',
      'get_current_time',
    ]);
  });
});

describe('loadNeuraSkills — real repo .neura/skills', () => {
  // Walk up from this test file to the repo root so the test isn't
  // sensitive to where vitest is run from. packages/core/src/skills/ →
  // ../../../../ lands in the repo root.
  const repoRoot = resolve(__dirname, '..', '..', '..', '..');

  it('loads the shipped orchestrator-worker-control skill as non-draft', () => {
    // Regression for B3: the shipped orchestrator skill was marked
    // `disable-model-invocation: true`, which caused
    // buildOrchestratorPromptPrefix() to filter it out and Grok to
    // silently lose all pause/resume/cancel routing directives. This
    // test loads the real file and asserts it survives the filter.
    const result = loadNeuraSkills({
      cwd: repoRoot,
      globalSkillsDir: hermeticGlobal,
    });

    const orchestrator = result.skills.find((s) => s.name === 'orchestrator-worker-control');
    expect(orchestrator).toBeDefined();
    expect(orchestrator?.disableModelInvocation).toBe(false);
    expect(orchestrator?.metadata.neura_level).toBe('orchestrator');
    expect(orchestrator?.body).toContain('pause_worker');
    expect(orchestrator?.body).toContain('resume_worker');
    expect(orchestrator?.body).toContain('cancel_worker');
  });
});

describe('toNeuraSkill', () => {
  function makePiSkill(name: string): PiSkill {
    return {
      name,
      description: 'test',
      filePath: resolve(fixtureCwd, '.neura', 'skills', name, 'SKILL.md'),
      baseDir: resolve(fixtureCwd, '.neura', 'skills', name),
      sourceInfo: {
        path: resolve(fixtureCwd, '.neura', 'skills', name),
        source: 'test',
        scope: 'project',
        origin: 'top-level',
      },
      disableModelInvocation: false,
    };
  }

  const paths = {
    repoLocal: resolve(fixtureCwd, '.neura', 'skills'),
    global: hermeticGlobal,
  };

  it('handles skills with explicit allowed-tools', () => {
    const { skill } = toNeuraSkill(makePiSkill('hello-world'), paths);

    expect(skill.hasExplicitAllowedTools).toBe(true);
    expect(skill.allowedTools).toEqual(['describe_screen', 'create_task']);
    expect(skill.metadata.neura_source).toBe('manual');
  });

  it('returns a diagnostics array alongside the skill', () => {
    const result = toNeuraSkill(makePiSkill('hello-world'), paths);

    // hello-world fixture is spec-clean; no diagnostics expected from toNeuraSkill.
    expect(result.diagnostics).toEqual([]);
  });

  it('normalizes empty-string and whitespace-only license/compatibility to undefined', () => {
    // Build a synthetic SKILL.md inline so the test is hermetic without a
    // new fixture directory.
    const tmpDir = resolve(__dirname, '__fixtures__', '_synthetic_empty_strings');
    const skillDir = resolve(tmpDir, 'empty-strings-skill');
    const skillPath = resolve(skillDir, 'SKILL.md');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      skillPath,
      `---
name: empty-strings-skill
description: Fixture whose license/compatibility are whitespace-only.
license: "   "
compatibility: ""
---
body
`
    );

    try {
      const piSkill: PiSkill = {
        name: 'empty-strings-skill',
        description: 'test',
        filePath: skillPath,
        baseDir: skillDir,
        sourceInfo: {
          path: skillDir,
          source: 'test',
          scope: 'project',
          origin: 'top-level',
        },
        disableModelInvocation: false,
      };

      const { skill } = toNeuraSkill(piSkill, paths);
      expect(skill.license).toBeUndefined();
      expect(skill.compatibility).toBeUndefined();
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('emits warning when license/compatibility is a non-string YAML value', () => {
    const tmpDir = resolve(__dirname, '__fixtures__', '_synthetic_non_string');
    const skillDir = resolve(tmpDir, 'non-string-skill');
    const skillPath = resolve(skillDir, 'SKILL.md');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      skillPath,
      `---
name: non-string-skill
description: Fixture with numeric license and array compatibility — both should warn.
license: 2026
compatibility:
  - MacOS
  - Linux
---
body
`
    );

    try {
      const piSkill: PiSkill = {
        name: 'non-string-skill',
        description: 'test',
        filePath: skillPath,
        baseDir: skillDir,
        sourceInfo: {
          path: skillDir,
          source: 'test',
          scope: 'project',
          origin: 'top-level',
        },
        disableModelInvocation: false,
      };

      const { skill, diagnostics } = toNeuraSkill(piSkill, paths);

      // Values are ignored (treated as missing).
      expect(skill.license).toBeUndefined();
      expect(skill.compatibility).toBeUndefined();

      // But author gets a warning for each, so the typo/mistake is visible.
      const licenseWarning = diagnostics.find(
        (d) => d.type === 'warning' && d.message.includes("'license'")
      );
      const compatWarning = diagnostics.find(
        (d) => d.type === 'warning' && d.message.includes("'compatibility'")
      );
      expect(licenseWarning).toBeDefined();
      expect(compatWarning).toBeDefined();
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
