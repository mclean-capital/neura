/**
 * Tests for skill-loader.ts.
 *
 * Uses co-located fixtures at __fixtures__/.neura/skills/ (copied from the
 * Spike #4d fixture set). The fixtures cover both a normal skill
 * (`hello-world`) and a draft skill (`draft-skill` with
 * `disable-model-invocation: true`).
 */

import { describe, it, expect } from 'vitest';
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

    expect(result.skills).toHaveLength(2);

    const helloWorld = result.skills.find((s) => s.name === 'hello-world');
    const draftSkill = result.skills.find((s) => s.name === 'draft-skill');

    expect(helloWorld).toBeDefined();
    expect(draftSkill).toBeDefined();

    // Both fixtures live under the repo-local path for this test.
    expect(helloWorld?.location).toBe('repo-local');
    expect(draftSkill?.location).toBe('repo-local');
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

describe('toNeuraSkill', () => {
  it('handles skills with explicit allowed-tools', () => {
    const piSkill: PiSkill = {
      name: 'hello-world',
      description: 'test',
      filePath: resolve(fixtureCwd, '.neura', 'skills', 'hello-world', 'SKILL.md'),
      baseDir: resolve(fixtureCwd, '.neura', 'skills', 'hello-world'),
      // SourceInfo shape from pi — minimal stub for the test. The loader
      // doesn't read this field; toNeuraSkill only uses filePath/baseDir/etc.
      sourceInfo: {
        path: resolve(fixtureCwd, '.neura', 'skills', 'hello-world'),
        source: 'test',
        scope: 'project',
        origin: 'top-level',
      },
      disableModelInvocation: false,
    };

    const neuraSkill = toNeuraSkill(piSkill, {
      repoLocal: resolve(fixtureCwd, '.neura', 'skills'),
      global: hermeticGlobal,
    });

    expect(neuraSkill.hasExplicitAllowedTools).toBe(true);
    expect(neuraSkill.allowedTools).toEqual(['describe_screen', 'create_task']);
    expect(neuraSkill.metadata.neura_source).toBe('manual');
  });
});
