/**
 * Phase 6 — Skill loader
 *
 * Thin wrapper around pi-coding-agent's `loadSkills()` that:
 *
 * 1. Configures pi's `skillPaths` in Neura's P4 priority order:
 *    repo-local (./.neura/skills) → global (~/.neura/skills) → explicit paths.
 *
 * 2. Re-parses each returned SKILL.md's frontmatter with pi's own
 *    `parseFrontmatter` utility, so Neura can extract custom fields pi's
 *    `Skill` type doesn't surface: `allowed-tools` and `metadata.*`.
 *
 * 3. Maps each skill's source path to a `SkillLocation` for Neura's shadow
 *    resolution rule (entire skill directory shadows lower-priority locations
 *    by name — no merging).
 *
 * 4. Surfaces diagnostics from both pi and Neura-specific checks (e.g.
 *    "skill has no allowed-tools, will run in minimal-capability mode").
 *
 * Verified against the Spike #4d fixtures. See docs/phase6-os-core.md for
 * design rationale.
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import {
  loadSkills as piLoadSkills,
  parseFrontmatter,
  type Skill as PiSkill,
} from '@mariozechner/pi-coding-agent';
import { Logger } from '@neura/utils/logger';
import type { NeuraSkill, LoadSkillsResult, SkillLocation, SkillDiagnostic } from '@neura/types';

const log = new Logger('skill-loader');

/**
 * Neura-specific default when a skill omits `allowed-tools` — see the
 * "`allowed-tools` absence policy" in docs/phase6-os-core.md. This is the
 * read-only introspection set that skill authors who failed to declare their
 * tool needs get access to. Skill authors who want more should declare
 * `allowed-tools` explicitly.
 */
export const MINIMAL_DEFAULT_ALLOWED_TOOLS: readonly string[] = [
  'list_skills',
  'recall_memory',
  'get_current_time',
];

export interface LoadNeuraSkillsOptions {
  /** Working directory for resolving `./.neura/skills/`. Default: process.cwd() */
  cwd?: string;

  /**
   * Override for the global skill directory. Default:
   * `${homedir()}/.neura/skills`.
   */
  globalSkillsDir?: string;

  /**
   * Additional paths passed through to pi's `skillPaths`. Processed after
   * repo-local and global, so they occupy the lowest-priority slots.
   */
  explicitPaths?: string[];
}

/**
 * Pi's SkillFrontmatter type is `{ [key: string]: unknown }`. We narrow the
 * fields Neura cares about but keep the rest accessible via the index signature.
 */
interface NeuraFrontmatter {
  name?: string;
  description?: string;
  'disable-model-invocation'?: boolean;
  'allowed-tools'?: string;
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * Load Neura skills from the three canonical locations (P4 order) plus any
 * explicit paths. Returns a flat array of `NeuraSkill` objects with all
 * custom frontmatter fields extracted, plus a diagnostics list.
 *
 * The priority order is applied via `skillPaths` ordering — pi's loader
 * honors the first-listed location as highest priority and shadows later
 * occurrences of the same skill `name`.
 */
export function loadNeuraSkills(options: LoadNeuraSkillsOptions = {}): LoadSkillsResult {
  const cwd = options.cwd ?? process.cwd();
  const repoLocal = resolve(cwd, '.neura', 'skills');
  const global = options.globalSkillsDir ?? resolve(homedir(), '.neura', 'skills');
  const explicit = options.explicitPaths ?? [];

  // P4 order: repo-local first (highest), then global, then explicit.
  const skillPaths = [repoLocal, global, ...explicit];

  log.info('loading Neura skills (repo-local → global → explicit, pi defaults excluded)', {
    cwd,
    skillPaths,
  });

  const piResult = piLoadSkills({
    cwd,
    skillPaths,
    // Explicitly skip pi's default locations. Neura owns its own skill paths;
    // users running pi separately should keep their pi skills untouched.
    includeDefaults: false,
  });

  const diagnostics: SkillDiagnostic[] = piResult.diagnostics.map((d) => ({
    // Pi's ResourceDiagnostic has `type` with values 'warning' | 'error'.
    type: d.type === 'error' ? 'error' : 'warning',
    message: d.message,
    path: d.path,
  }));

  const skills: NeuraSkill[] = [];
  for (const piSkill of piResult.skills) {
    try {
      const neuraSkill = toNeuraSkill(piSkill, { repoLocal, global });
      skills.push(neuraSkill);

      // Neura-specific diagnostic: warn on missing allowed-tools.
      if (!neuraSkill.hasExplicitAllowedTools) {
        diagnostics.push({
          type: 'warning',
          message: `Skill '${neuraSkill.name}' has no 'allowed-tools' field; will run with Neura's read-only default tool set (${MINIMAL_DEFAULT_ALLOWED_TOOLS.join(', ')}). See 'allowed-tools absence policy' in the design doc.`,
          path: neuraSkill.filePath,
        });
      }
    } catch (err) {
      diagnostics.push({
        type: 'error',
        message: `Failed to re-parse SKILL.md for custom fields: ${String(err)}`,
        path: piSkill.filePath,
      });
    }
  }

  log.info('Neura skill load complete', {
    skillCount: skills.length,
    diagnosticCount: diagnostics.length,
  });

  return { skills, diagnostics };
}

/**
 * Convert a pi `Skill` to a `NeuraSkill` by re-reading the SKILL.md file and
 * extracting the custom frontmatter fields pi's type doesn't surface.
 *
 * Exported for testing.
 */
export function toNeuraSkill(
  piSkill: PiSkill,
  paths: { repoLocal: string; global: string }
): NeuraSkill {
  const rawContent = readFileSync(piSkill.filePath, 'utf8');
  const { frontmatter, body } = parseFrontmatter<NeuraFrontmatter>(rawContent);

  // Parse `allowed-tools` (spec: space-delimited string)
  const allowedToolsRaw = frontmatter['allowed-tools'];
  const hasExplicitAllowedTools = typeof allowedToolsRaw === 'string';
  const allowedTools: string[] = hasExplicitAllowedTools
    ? allowedToolsRaw
        .trim()
        .split(/\s+/)
        .filter((t) => t.length > 0)
    : [];

  // Parse `metadata` (spec: arbitrary nested key-value mapping)
  const metadata: Record<string, unknown> =
    frontmatter.metadata && typeof frontmatter.metadata === 'object'
      ? { ...frontmatter.metadata }
      : {};

  return {
    name: piSkill.name,
    description: piSkill.description,
    filePath: piSkill.filePath,
    baseDir: piSkill.baseDir,
    location: resolveSkillLocation(piSkill.filePath, paths),
    disableModelInvocation: piSkill.disableModelInvocation,
    allowedTools,
    hasExplicitAllowedTools,
    metadata,
    body,
  };
}

/**
 * Determine where a skill was loaded from, based on whether its filePath is
 * inside the repo-local or global directory. Anything else is `explicit`.
 */
function resolveSkillLocation(
  filePath: string,
  paths: { repoLocal: string; global: string }
): SkillLocation {
  const abs = resolve(filePath);
  if (abs.startsWith(resolve(paths.repoLocal))) return 'repo-local';
  if (abs.startsWith(resolve(paths.global))) return 'global';
  return 'explicit';
}
