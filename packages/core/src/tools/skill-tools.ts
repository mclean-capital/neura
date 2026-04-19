/**
 * Phase 6b — Skill tools exposed to Grok via the tool router.
 *
 * After the Phase 6b refactor, skills are reference documentation (per the
 * agentskills.io spec), not a capability gate. Execution flows through
 * task dispatch (`dispatch_worker`), not through skills. What remains here:
 *
 *   - `list_skills`   — tell me what skills are installed
 *   - `get_skill`     — describe a specific skill
 *   - `promote_skill` — clear the `disable-model-invocation` flag on a
 *                       draft skill so it's visible in the worker catalog
 *
 * Contract: every handler returns either `{ result: ... }` on success or
 * `{ error: 'msg' }` on failure. Grok's tool-call response path reads
 * those shapes and formats the tool result for the LLM.
 *
 * See docs/phase6b-task-driven-execution.md for the design rationale.
 */

import type { ToolDefinition } from '@neura/types';
import { Logger } from '@neura/utils/logger';
import type { ToolCallContext } from './types.js';

const log = new Logger('tool:skill');

export const skillToolDefs: ToolDefinition[] = [
  {
    type: 'function',
    name: 'list_skills',
    description:
      "List every skill Neura has installed. Skills are reference documentation about how to perform domain-specific work (uploading to a specific CMS, interacting with a private API, etc.) — they're consulted by workers when a task references them. Use when the user asks what skills/docs are available. Includes drafts marked 'disable-model-invocation: true'.",
    parameters: {
      type: 'object',
      properties: {},
    },
  },
  {
    type: 'function',
    name: 'get_skill',
    description:
      'Get details about a specific skill by name, including its license, compatibility requirements, and metadata. Use when the user asks what a particular skill documents or wants to inspect it.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Skill name (kebab-case)' },
      },
      required: ['name'],
    },
  },
  {
    type: 'function',
    name: 'promote_skill',
    description:
      "Clear the 'disable-model-invocation' flag on a draft skill so it becomes visible in worker skill catalogs. Use when the user says a skill looks good and should be activated.",
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Skill name to promote' },
      },
      required: ['name'],
    },
  },
];

const SKILL_NAMES = new Set(skillToolDefs.map((d) => d.name));

export function isSkillTool(name: string): boolean {
  return SKILL_NAMES.has(name);
}

export async function handleSkillTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolCallContext
): Promise<Record<string, unknown> | null> {
  if (!SKILL_NAMES.has(name)) return null;
  if (!ctx.skillTools) return { error: 'Skill system not available' };

  try {
    switch (name) {
      case 'list_skills': {
        const skills = ctx.skillTools.listSkills();
        return {
          result: {
            count: skills.length,
            skills: skills.map((s) => ({
              name: s.name,
              description: s.description,
              location: s.location,
              draft: s.disableModelInvocation,
              license: s.license,
              compatibility: s.compatibility,
            })),
          },
        };
      }

      case 'get_skill': {
        const skillName = args.name as string;
        const skill = ctx.skillTools.getSkill(skillName);
        if (!skill) return { result: { found: false } };
        return {
          result: {
            found: true,
            name: skill.name,
            description: skill.description,
            location: skill.location,
            draft: skill.disableModelInvocation,
            metadata: skill.metadata,
            license: skill.license,
            compatibility: skill.compatibility,
          },
        };
      }

      case 'promote_skill': {
        const skillName = args.name as string;
        const promoted = await ctx.skillTools.promoteSkill(skillName);
        return { result: promoted };
      }

      default:
        return null;
    }
  } catch (err) {
    log.error(`${name} failed`, { err: String(err) });
    return { error: `Failed: ${String(err)}` };
  }
}
