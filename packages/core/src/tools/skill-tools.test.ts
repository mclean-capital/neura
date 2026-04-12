/**
 * Tests for skill-tools.ts — the Grok-facing tools that dispatch
 * skill-related workers and surface the skill registry.
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
    runSkill: vi.fn().mockResolvedValue({ workerId: 'wk-1' }),
    createSkill: vi.fn().mockResolvedValue({ workerId: 'wk-2' }),
    promoteSkill: vi.fn().mockResolvedValue({ promoted: true }),
    importSkill: vi.fn().mockResolvedValue({ imported: true, count: 3 }),
    ...overrides,
  };
  return {
    queryWatcher: vi.fn().mockResolvedValue(''),
    skillTools,
  };
}

describe('skillToolDefs', () => {
  it('exposes all six skill tool names', () => {
    const names = skillToolDefs.map((d) => d.name).sort();
    expect(names).toEqual([
      'create_skill',
      'get_skill',
      'import_skill',
      'list_skills',
      'promote_skill',
      'run_skill',
    ]);
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
          result: { found: boolean; name: string; allowedTools: string[] };
        }
      ).result;
      expect(payload.found).toBe(true);
      expect(payload.name).toBe('red-test-triage');
      expect(payload.allowedTools).toEqual(['describe_screen', 'create_task']);
    });
  });

  describe('run_skill', () => {
    it('dispatches a worker and returns the worker id', async () => {
      const runMock = vi.fn().mockResolvedValue({ workerId: 'wk-42' });
      const ctx = makeCtx({ runSkill: runMock });
      const result = await handleSkillTool(
        'run_skill',
        { skill_name: 'red-test-triage', description: 'look at the failing test' },
        ctx
      );
      expect(runMock).toHaveBeenCalledWith('red-test-triage', 'look at the failing test');
      const payload = (
        result as {
          result: { dispatched: boolean; workerId: string };
        }
      ).result;
      expect(payload.dispatched).toBe(true);
      expect(payload.workerId).toBe('wk-42');
    });
  });

  describe('create_skill', () => {
    it('dispatches an authoring worker and returns the worker id', async () => {
      const createMock = vi.fn().mockResolvedValue({ workerId: 'wk-99' });
      const ctx = makeCtx({ createSkill: createMock });
      const result = await handleSkillTool(
        'create_skill',
        { description: 'a skill that backs up my photos' },
        ctx
      );
      expect(createMock).toHaveBeenCalledWith('a skill that backs up my photos');
      const payload = (
        result as {
          result: { workerId: string };
        }
      ).result;
      expect(payload.workerId).toBe('wk-99');
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

  describe('import_skill', () => {
    it('calls importSkill with the path', async () => {
      const importMock = vi.fn().mockResolvedValue({ imported: true, count: 5 });
      const ctx = makeCtx({ importSkill: importMock });
      const result = await handleSkillTool('import_skill', { path: '/Users/test/my-skills' }, ctx);
      expect(importMock).toHaveBeenCalledWith('/Users/test/my-skills');
      expect(result).toEqual({ result: { imported: true, count: 5 } });
    });
  });

  describe('error handling', () => {
    it('converts thrown handler errors into a tool error result', async () => {
      const runMock = vi.fn().mockRejectedValue(new Error('skill not found'));
      const ctx = makeCtx({ runSkill: runMock });
      const result = await handleSkillTool(
        'run_skill',
        { skill_name: 'unknown', description: 'x' },
        ctx
      );
      expect(result).toBeDefined();
      expect((result as { error: string }).error).toContain('skill not found');
    });
  });
});
