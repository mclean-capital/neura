/**
 * Tests for skill-registry.ts.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import type { NeuraSkill } from '@neura/types';
import { SkillRegistry, estimateSkillPromptCost } from './skill-registry.js';
import { MINIMAL_DEFAULT_ALLOWED_TOOLS } from './skill-loader.js';

function makeSkill(overrides: Partial<NeuraSkill> = {}): NeuraSkill {
  return {
    name: 'test-skill',
    description: 'A test skill.',
    filePath: '/tmp/test-skill/SKILL.md',
    baseDir: '/tmp/test-skill',
    location: 'repo-local',
    disableModelInvocation: false,
    allowedTools: [],
    hasExplicitAllowedTools: false,
    metadata: {},
    body: 'body',
    ...overrides,
  };
}

describe('SkillRegistry', () => {
  let registry: SkillRegistry;

  beforeEach(() => {
    registry = new SkillRegistry();
  });

  describe('list / get / has', () => {
    it('starts empty', () => {
      expect(registry.size).toBe(0);
      expect(registry.list()).toEqual([]);
    });

    it('exposes skills after replaceAll()', () => {
      registry.replaceAll([makeSkill({ name: 'alpha' }), makeSkill({ name: 'beta' })]);
      expect(registry.size).toBe(2);
      expect(registry.has('alpha')).toBe(true);
      expect(registry.has('missing')).toBe(false);
      expect(registry.get('alpha')?.name).toBe('alpha');
    });

    it('replaceAll() includes draft skills for list()', () => {
      // list() is used by the list_skills tool — drafts SHOULD appear
      // here (introspection), only getPromptContext() filters them.
      registry.replaceAll([
        makeSkill({ name: 'alpha' }),
        makeSkill({ name: 'draft', disableModelInvocation: true }),
      ]);
      expect(registry.list()).toHaveLength(2);
    });
  });

  describe('getAllowedTools', () => {
    it('returns the explicit list when the skill declared allowed-tools', () => {
      registry.replaceAll([
        makeSkill({
          name: 'explicit',
          allowedTools: ['describe_screen', 'create_task'],
          hasExplicitAllowedTools: true,
        }),
      ]);
      expect(registry.getAllowedTools('explicit')).toEqual(['describe_screen', 'create_task']);
    });

    it('returns the MINIMAL default when the skill omitted allowed-tools', () => {
      registry.replaceAll([
        makeSkill({ name: 'implicit', hasExplicitAllowedTools: false, allowedTools: [] }),
      ]);
      expect(registry.getAllowedTools('implicit')).toEqual(MINIMAL_DEFAULT_ALLOWED_TOOLS);
    });

    it('returns undefined for unknown skills (hard refusal signal)', () => {
      registry.replaceAll([makeSkill({ name: 'alpha' })]);
      expect(registry.getAllowedTools('unknown')).toBeUndefined();
    });
  });

  describe('notifyUsed / MRU tracking', () => {
    it('bumps MRU order for recently-used skills', () => {
      registry.replaceAll([
        makeSkill({ name: 'alpha' }),
        makeSkill({ name: 'beta' }),
        makeSkill({ name: 'gamma' }),
      ]);

      // Use alpha, then gamma — beta is the stale one.
      registry.notifyUsed('alpha');
      registry.notifyUsed('gamma');

      // Cheap way to inspect MRU order: request a very small budget so
      // only the most-recently-used skill fits. gamma was used last.
      const prompt = registry.getPromptContext(30);
      expect(prompt).toContain('gamma');
      expect(prompt).not.toContain('beta');
    });

    it('notifyUsed is a no-op for unknown skills', () => {
      registry.replaceAll([makeSkill({ name: 'alpha' })]);
      expect(() => registry.notifyUsed('does-not-exist')).not.toThrow();
    });

    it('fires onSkillUsed listener', () => {
      const calls: { name: string; ts: number }[] = [];
      const r = new SkillRegistry({
        onSkillUsed: (name, ts) => calls.push({ name, ts }),
      });
      r.replaceAll([makeSkill({ name: 'alpha' })]);
      r.notifyUsed('alpha');
      expect(calls).toHaveLength(1);
      expect(calls[0]?.name).toBe('alpha');
      expect(calls[0]?.ts).toBeGreaterThan(0);
    });

    it('replaceAll preserves MRU for skills that survive the reload', () => {
      registry.replaceAll([makeSkill({ name: 'alpha' }), makeSkill({ name: 'beta' })]);
      registry.notifyUsed('alpha');

      // Reload — alpha survives, beta is replaced, a new gamma joins.
      registry.replaceAll([makeSkill({ name: 'alpha' }), makeSkill({ name: 'gamma' })]);

      // alpha should still have MRU precedence over gamma (never-used).
      const prompt = registry.getPromptContext(30);
      expect(prompt).toContain('alpha');
      expect(prompt).not.toContain('gamma');
    });
  });

  describe('getPromptContext', () => {
    it('returns empty string when no skills are loaded', () => {
      expect(registry.getPromptContext(10_000)).toBe('');
    });

    it('returns empty string when all skills are drafts', () => {
      registry.replaceAll([
        makeSkill({ name: 'draft-a', disableModelInvocation: true }),
        makeSkill({ name: 'draft-b', disableModelInvocation: true }),
      ]);
      expect(registry.getPromptContext(10_000)).toBe('');
    });

    it('filters drafts but includes non-draft skills', () => {
      registry.replaceAll([
        makeSkill({ name: 'ready' }),
        makeSkill({ name: 'hidden', disableModelInvocation: true }),
      ]);
      const prompt = registry.getPromptContext(10_000);
      expect(prompt).toContain('ready');
      expect(prompt).not.toContain('hidden');
    });

    it('respects a zero budget by returning empty', () => {
      registry.replaceAll([makeSkill({ name: 'alpha' })]);
      expect(registry.getPromptContext(0)).toBe('');
    });

    it('evicts oldest MRU skills to fit a tight budget', () => {
      // Three skills with roughly equal cost per the estimator.
      registry.replaceAll([
        makeSkill({ name: 'alpha', description: 'An alpha skill description.' }),
        makeSkill({ name: 'beta', description: 'A beta skill description.' }),
        makeSkill({ name: 'gamma', description: 'A gamma skill description.' }),
      ]);
      registry.notifyUsed('gamma'); // gamma is most-recent

      // Budget large enough for exactly one skill.
      const prompt = registry.getPromptContext(25);
      expect(prompt).toContain('gamma'); // most-recently-used wins
    });
  });

  describe('estimateSkillPromptCost', () => {
    it('returns a positive cost that grows with name+description length', () => {
      const small = estimateSkillPromptCost(makeSkill({ name: 'a', description: 'b' }));
      const large = estimateSkillPromptCost(
        makeSkill({ name: 'xxxxxxxxxx', description: 'y'.repeat(100) })
      );
      expect(small).toBeGreaterThan(0);
      expect(large).toBeGreaterThan(small);
    });
  });
});
