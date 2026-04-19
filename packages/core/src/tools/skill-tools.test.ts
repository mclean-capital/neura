/**
 * Tests for skill-tools.ts — the Grok-facing tools that surface the skill
 * registry.
 *
 * Phase 6b: skills are reference documentation, not a capability gate.
 * `run_skill`, `create_skill`, `import_skill` removed. The surface is now
 * `list_skills`, `get_skill`, `promote_skill`.
 */

import { describe, it, expect, vi } from 'vitest';
import type { NeuraSkill } from '@neura/types';
import type { SkillToolHandler, ToolCallContext } from './types.js';
import { handleSkillTool, isSkillTool, skillToolDefs } from './skill-tools.js';

function makeSkill(overrides: Partial<NeuraSkill> = {}): NeuraSkill {
  return {
    name: 'red-test-triage',
    description: 'Triage failing tests from screen output.',
    filePath: '/tmp/red-test-triage/SKILL.md',
    baseDir: '/tmp/red-test-triage',
    location: 'repo-local',
    disableModelInvocation: false,
    allowedTools: ['describe_screen', 'create_task'],
    hasExplicitAllowedTools: true,
    metadata: { neura_source: 'manual' },
    body: 'body',
    ...overrides,
  };
}

function makeCtx(overrides: Partial<SkillToolHandler> = {}): ToolCallContext {
  const skillTools: SkillToolHandler = {
    listSkills: () => [makeSkill()],
    getSkill: (name) => (name === 'red-test-triage' ? makeSkill() : undefined),
    promoteSkill: vi.fn().mockResolvedValue({ promoted: true }),
    ...overrides,
  };
  return {
    queryWatcher: vi.fn().mockResolvedValue(''),
    skillTools,
  };
}

describe('skillToolDefs', () => {
  it('exposes exactly the three skill tool names', () => {
    const names = skillToolDefs.map((d) => d.name).sort();
    expect(names).toEqual(['get_skill', 'list_skills', 'promote_skill']);
  });

  it('every tool has a description and parameter schema', () => {
    for (const def of skillToolDefs) {
      expect(def.description).toBeTruthy();
      expect(def.parameters).toBeDefined();
    }
  });
});

describe('isSkillTool', () => {
  it('returns true for every tool name in skillToolDefs', () => {
    for (const def of skillToolDefs) {
      expect(isSkillTool(def.name)).toBe(true);
    }
  });

  it('returns false for unknown tool names', () => {
    expect(isSkillTool('remember_fact')).toBe(false);
    expect(isSkillTool('totally_fake')).toBe(false);
  });

  it('returns false for Phase 6b-removed tools', () => {
    expect(isSkillTool('run_skill')).toBe(false);
    expect(isSkillTool('create_skill')).toBe(false);
    expect(isSkillTool('import_skill')).toBe(false);
  });
});

describe('handleSkillTool', () => {
  it('returns null for tools outside the skill set (routes to next handler)', async () => {
    const result = await handleSkillTool('remember_fact', {}, makeCtx());
    expect(result).toBeNull();
  });

  it('returns error when skillTools is not available', async () => {
    const ctx: ToolCallContext = {
      queryWatcher: vi.fn().mockResolvedValue(''),
    };
    const result = await handleSkillTool('list_skills', {}, ctx);
    expect(result).toEqual({ error: 'Skill system not available' });
  });

  describe('list_skills', () => {
    it('returns the registry contents with count and summaries', async () => {
      const result = await handleSkillTool('list_skills', {}, makeCtx());
      expect(result).toBeDefined();
      const payload = (result as { result: { count: number; skills: { name: string }[] } }).result;
      expect(payload.count).toBe(1);
      expect(payload.skills[0]?.name).toBe('red-test-triage');
    });

    it('surfaces license + compatibility for each skill (agentskills.io spec)', async () => {
      const ctx = makeCtx({
        listSkills: () => [
          makeSkill({
            license: 'Apache-2.0',
            compatibility: 'Requires macOS and ffmpeg',
          }),
        ],
      });
      const result = await handleSkillTool('list_skills', {}, ctx);
      const payload = (
        result as {
          result: {
            skills: { license?: string; compatibility?: string }[];
          };
        }
      ).result;
      expect(payload.skills[0]?.license).toBe('Apache-2.0');
      expect(payload.skills[0]?.compatibility).toBe('Requires macOS and ffmpeg');
    });
  });

  describe('get_skill', () => {
    it('returns found:false when the skill is not in the registry', async () => {
      const result = await handleSkillTool('get_skill', { name: 'does-not-exist' }, makeCtx());
      expect(result).toEqual({ result: { found: false } });
    });

    it('returns full skill details for a known skill', async () => {
      const result = await handleSkillTool('get_skill', { name: 'red-test-triage' }, makeCtx());
      const payload = (
        result as {
          result: { found: boolean; name: string };
        }
      ).result;
      expect(payload.found).toBe(true);
      expect(payload.name).toBe('red-test-triage');
    });

    it('surfaces license + compatibility when present (agentskills.io spec)', async () => {
      const ctx = makeCtx({
        getSkill: (name) =>
          name === 'red-test-triage'
            ? makeSkill({ license: 'MIT', compatibility: 'Requires git, jq' })
            : undefined,
      });
      const result = await handleSkillTool('get_skill', { name: 'red-test-triage' }, ctx);
      const payload = (
        result as {
          result: { license?: string; compatibility?: string };
        }
      ).result;
      expect(payload.license).toBe('MIT');
      expect(payload.compatibility).toBe('Requires git, jq');
    });
  });

  describe('promote_skill', () => {
    it('calls promoteSkill with the target name', async () => {
      const promoteMock = vi.fn().mockResolvedValue({ promoted: true });
      const ctx = makeCtx({ promoteSkill: promoteMock });
      await handleSkillTool('promote_skill', { name: 'draft-skill' }, ctx);
      expect(promoteMock).toHaveBeenCalledWith('draft-skill');
    });
  });

  describe('error handling', () => {
    it('converts thrown handler errors into a tool error result', async () => {
      const promoteMock = vi.fn().mockRejectedValue(new Error('skill not found'));
      const ctx = makeCtx({ promoteSkill: promoteMock });
      const result = await handleSkillTool('promote_skill', { name: 'unknown' }, ctx);
      expect(result).toBeDefined();
      expect((result as { error: string }).error).toContain('skill not found');
    });
  });
});
