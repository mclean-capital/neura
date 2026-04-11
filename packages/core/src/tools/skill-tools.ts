/**
 * Phase 6 — Skill tools exposed to Grok via the tool router.
 *
 * These are the user-facing entry points for interacting with the skill
 * framework during a voice session:
 *
 *   - `list_skills`   — tell me what skills are installed
 *   - `get_skill`     — describe a specific skill
 *   - `run_skill`     — dispatch a worker to execute a skill (async)
 *   - `create_skill`  — dispatch a worker that AUTHORS a new skill from
 *                       a free-form description
 *   - `promote_skill` — clear the `disable-model-invocation` flag on a
 *                       draft skill so it becomes auto-invocable
 *   - `import_skill`  — register an explicit filesystem path
 *
 * Contract: every handler returns either `{ result: ... }` on success or
 * `{ error: 'msg' }` on failure. Grok's tool-call response path reads
 * those shapes and formats the tool result for the LLM.
 *
 * `run_skill` and `create_skill` are ASYNC — they dispatch a worker and
 * return `worker_id` immediately without awaiting completion. Progress
 * flows to the user via `grokSession.interject()` ambient voice updates
 * from the `VoiceFanoutBridge`. The final result arrives as one last
 * interject when the worker completes.
 *
 * This matches the design doc decision documented in "`run_skill` is
 * async" and avoids blocking Grok's turn for the full worker duration.
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
      "List every skill Neura has installed. Use when the user asks what skills are available, what Neura can do, or wants to see their skill catalog. Includes draft skills marked 'disable-model-invocation: true' — those are loaded but not auto-invocable until promoted.",
    parameters: {
      type: 'object',
      properties: {},
    },
  },
  {
    type: 'function',
    name: 'get_skill',
    description:
      'Get details about a specific skill by name. Use when the user asks what a particular skill does or wants to inspect its metadata.',
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
    name: 'run_skill',
    description:
      "Dispatch a worker to execute a skill with a task description. Use when the user asks to run a specific skill. Returns a worker_id immediately — the worker runs asynchronously and you'll hear progress updates via voice as it works. You do NOT need to wait for completion before replying — just acknowledge the dispatch.",
    parameters: {
      type: 'object',
      properties: {
        skill_name: { type: 'string', description: 'Name of the skill to run' },
        description: {
          type: 'string',
          description:
            "Plain-language description of what the user wants this run to accomplish (e.g. 'triage the failing test on screen')",
        },
      },
      required: ['skill_name', 'description'],
    },
  },
  {
    type: 'function',
    name: 'create_skill',
    description:
      "Dispatch a worker to AUTHOR a new skill from a free-form description. Use when the user asks you to create a skill for a specific task they want to repeat. The worker runs asynchronously and drops a draft SKILL.md into ~/.neura/skills/; tell the user the skill is being created and they'll hear when it's ready.",
    parameters: {
      type: 'object',
      properties: {
        description: {
          type: 'string',
          description:
            'What the new skill should do, in the same tone the user described it — include context, tools needed, trigger phrases.',
        },
      },
      required: ['description'],
    },
  },
  {
    type: 'function',
    name: 'promote_skill',
    description:
      "Clear the 'disable-model-invocation' flag on a draft skill so it becomes auto-invocable. Use when the user says a skill looks good and should be activated, or when promoting a skill captured from a clarification exchange.",
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Skill name to promote' },
      },
      required: ['name'],
    },
  },
  {
    type: 'function',
    name: 'import_skill',
    description:
      'Register an explicit filesystem path as a skill source. Use when the user points at a local directory containing SKILL.md files they want to load. URLs and git paths are Phase 9 marketplace scope — this only takes local filesystem paths.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute filesystem path to a skill directory' },
      },
      required: ['path'],
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
              allowedTools: s.allowedTools,
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
            allowedTools: skill.allowedTools,
            metadata: skill.metadata,
          },
        };
      }

      case 'run_skill': {
        const skillName = args.skill_name as string;
        const description = args.description as string;
        const dispatched = await ctx.skillTools.runSkill(skillName, description);
        return {
          result: {
            dispatched: true,
            workerId: dispatched.workerId,
            skillName,
            message: `Worker ${dispatched.workerId} dispatched. You'll hear progress updates as it runs.`,
          },
        };
      }

      case 'create_skill': {
        const description = args.description as string;
        const dispatched = await ctx.skillTools.createSkill(description);
        return {
          result: {
            dispatched: true,
            workerId: dispatched.workerId,
            message: `Worker ${dispatched.workerId} is authoring a new skill. You'll hear when it's ready.`,
          },
        };
      }

      case 'promote_skill': {
        const skillName = args.name as string;
        const promoted = await ctx.skillTools.promoteSkill(skillName);
        return { result: promoted };
      }

      case 'import_skill': {
        const path = args.path as string;
        const imported = await ctx.skillTools.importSkill(path);
        return { result: imported };
      }

      default:
        return null;
    }
  } catch (err) {
    log.error(`${name} failed`, { err: String(err) });
    return { error: `Failed: ${String(err)}` };
  }
}
