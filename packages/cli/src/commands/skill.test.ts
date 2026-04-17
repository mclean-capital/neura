import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { __test__, skillValidateCommand } from './skill.js';

const { checkLicense, checkCompatibility } = __test__;

describe('checkLicense', () => {
  it('returns empty when license is absent', () => {
    expect(checkLicense('x', '/tmp/x/SKILL.md', undefined)).toEqual([]);
  });

  it('returns empty when license is a valid string', () => {
    expect(checkLicense('x', '/tmp/x/SKILL.md', 'MIT')).toEqual([]);
  });

  it('warns when license is not a string (number)', () => {
    const result = checkLicense('x', '/tmp/x/SKILL.md', 2026);
    expect(result).toHaveLength(1);
    expect(result[0]?.type).toBe('warning');
    expect(result[0]?.message).toContain("'license'");
    expect(result[0]?.message).toContain('number');
  });

  it('warns when license is not a string (array)', () => {
    const result = checkLicense('x', '/tmp/x/SKILL.md', ['MIT']);
    expect(result).toHaveLength(1);
    expect(result[0]?.type).toBe('warning');
  });
});

describe('checkCompatibility', () => {
  it('returns empty when compatibility is absent', () => {
    expect(checkCompatibility('x', '/tmp/x/SKILL.md', undefined)).toEqual([]);
  });

  it('returns empty when compatibility is within the 500-char cap', () => {
    expect(checkCompatibility('x', '/tmp/x/SKILL.md', 'Requires ffmpeg')).toEqual([]);
  });

  it('warns when compatibility exceeds the spec cap', () => {
    const over = 'a'.repeat(501);
    const result = checkCompatibility('x', '/tmp/x/SKILL.md', over);
    expect(result).toHaveLength(1);
    expect(result[0]?.message).toContain('501');
    expect(result[0]?.message).toContain('500');
  });

  it('warns when compatibility is not a string', () => {
    const result = checkCompatibility('x', '/tmp/x/SKILL.md', 42);
    expect(result).toHaveLength(1);
    expect(result[0]?.message).toContain("'compatibility'");
  });
});

describe('skillValidateCommand', () => {
  let tmpDir: string;
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'neura-skill-validate-'));
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called');
    }) as never);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    exitSpy.mockRestore();
    logSpy.mockRestore();
  });

  function writeSkill(name: string, frontmatter: string, body = 'body'): string {
    const dir = join(tmpDir, name);
    mkdirSync(dir, { recursive: true });
    const skillPath = join(dir, 'SKILL.md');
    writeFileSync(skillPath, `---\n${frontmatter}\n---\n\n${body}\n`);
    return dir;
  }

  it('exits 0 when a valid skill passes all checks', () => {
    writeSkill(
      'valid-skill',
      `name: valid-skill
description: A clean spec-compliant skill.
license: MIT
compatibility: Requires nothing unusual`
    );

    skillValidateCommand(tmpDir);

    expect(exitSpy).not.toHaveBeenCalled();
    const output = logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
    expect(output).toContain('pass agentskills.io spec validation');
  });

  it('exits 1 when pi reports a name violation (uppercase)', () => {
    writeSkill(
      'bad-name',
      `name: Bad-Name
description: Violates the lowercase-only rule.`
    );

    expect(() => skillValidateCommand(tmpDir)).toThrow('process.exit called');

    expect(exitSpy).toHaveBeenCalledWith(1);
    const output = logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
    expect(output).toMatch(/invalid characters|lowercase|does not match/i);
  });

  it('exits 1 when compatibility exceeds 500 chars', () => {
    writeSkill(
      'over-compat',
      `name: over-compat
description: Intentionally over-length compatibility.
compatibility: ${'x'.repeat(520)}`
    );

    expect(() => skillValidateCommand(tmpDir)).toThrow('process.exit called');

    expect(exitSpy).toHaveBeenCalledWith(1);
    const output = logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
    expect(output).toContain('500');
  });

  it('exits 1 when no SKILL.md is found', () => {
    expect(() => skillValidateCommand(tmpDir)).toThrow('process.exit called');

    expect(exitSpy).toHaveBeenCalledWith(1);
    const output = logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
    expect(output).toContain('No SKILL.md found');
  });
});
