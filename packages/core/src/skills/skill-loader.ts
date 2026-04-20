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

export interface LoadNeuraSkillsOptions {
  /** Working directory for resolving `./.neura/skills/`. Default: process.cwd() */
  cwd?: string;

  /**
   * Override for the global skill directory. Default:
   * `${homedir()}/.neura/skills`.
   */
  globalSkillsDir?: string;

  /**
   * Directory of skills shipped with the Neura install. Used by the CLI
   * to deliver built-in orchestrator skills (e.g. `orchestrator-worker-control`)
   * that would otherwise miss users who haven't cloned the repo. Loaded
   * AFTER repo-local and global so a user override wins, but BEFORE
   * `explicitPaths`.
   */
  bundledSkillsDir?: string;

  /**
   * Additional paths passed through to pi's `skillPaths`. Processed after
   * bundled, so they occupy the lowest-priority slots.
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
  license?: string;
  compatibility?: string;
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
}

const COMPATIBILITY_MAX_LENGTH = 500;

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

  // Priority order: repo-local (highest) → global → bundled → explicit.
  // Bundled skills ship with the CLI so orchestrator defaults reach
  // users who never cloned the repo; user overrides at repo-local or
  // global shadow the bundled copy by skill `name`.
  const skillPaths = [repoLocal, global];
  if (options.bundledSkillsDir) skillPaths.push(options.bundledSkillsDir);
  skillPaths.push(...explicit);

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
      const { skill: neuraSkill, diagnostics: skillDiagnostics } = toNeuraSkill(piSkill, {
        repoLocal,
        global,
      });
      skills.push(neuraSkill);
      diagnostics.push(...skillDiagnostics);

      // Phase 6b: the `allowed-tools` absence warning was removed.
      // Runtime enforcement of `allowed-tools` was also removed — skills are
      // now reference documentation, not a capability gate. The field is
      // still parsed (still agentskills.io-compliant) and surfaced on the
      // NeuraSkill object; it's informational only until a concrete use
      // case reintroduces enforcement.

      // Spec compliance: `compatibility` must be ≤ 500 chars (agentskills.io).
      // Warning (not error): the skill still loads, author gets a nudge.
      if (
        neuraSkill.compatibility !== undefined &&
        neuraSkill.compatibility.length > COMPATIBILITY_MAX_LENGTH
      ) {
        diagnostics.push({
          type: 'warning',
          message: `Skill '${neuraSkill.name}' has 'compatibility' field of ${neuraSkill.compatibility.length} characters; agentskills.io spec caps it at ${COMPATIBILITY_MAX_LENGTH}.`,
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
 * Result of converting a pi `Skill` to Neura's shape. Diagnostics are
 * surfaced from frontmatter inspection so the caller can aggregate them
 * alongside its own checks.
 */
export interface ToNeuraSkillResult {
  skill: NeuraSkill;
  diagnostics: SkillDiagnostic[];
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
): ToNeuraSkillResult {
  const rawContent = readFileSync(piSkill.filePath, 'utf8');
  const { frontmatter, body } = parseFrontmatter<NeuraFrontmatter>(rawContent);
  const diagnostics: SkillDiagnostic[] = [];

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

  const license = parseStringField(frontmatter.license, 'license', piSkill, diagnostics);
  const compatibility = parseStringField(
    frontmatter.compatibility,
    'compatibility',
    piSkill,
    diagnostics
  );

  return {
    skill: {
      name: piSkill.name,
      description: piSkill.description,
      filePath: piSkill.filePath,
      baseDir: piSkill.baseDir,
      location: resolveSkillLocation(piSkill.filePath, paths),
      disableModelInvocation: piSkill.disableModelInvocation,
      allowedTools,
      hasExplicitAllowedTools,
      metadata,
      license,
      compatibility,
      body,
    },
    diagnostics,
  };
}

/**
 * Narrow an optional string frontmatter field, normalize whitespace/empty,
 * and emit a diagnostic when the YAML value is the wrong type. Spec says
 * these fields are strings; silently ignoring a number or array would hide
 * an authoring bug from the skill author.
 */
function parseStringField(
  raw: unknown,
  fieldName: 'license' | 'compatibility',
  piSkill: PiSkill,
  diagnostics: SkillDiagnostic[]
): string | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string') {
    diagnostics.push({
      type: 'warning',
      message: `Skill '${piSkill.name}' has '${fieldName}' field of type ${typeof raw}; agentskills.io spec requires a string. Value ignored.`,
      path: piSkill.filePath,
    });
    return undefined;
  }
  const trimmed = raw.trim();
  return trimmed.length === 0 ? undefined : trimmed;
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
