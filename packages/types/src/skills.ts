/**
 * Phase 6 — Skill types
 *
 * Neura follows the Anthropic Agent Skills spec verbatim. There are ZERO
 * Neura-invented top-level frontmatter fields — any Neura-specific metadata
 * lives under the spec's `metadata` nested field. See docs/phase6-os-core.md
 * for the full design and rationale.
 */

/**
 * Where a skill was loaded from. Priority order matches P4 in the design doc:
 * repo-local (highest) → global → explicit.
 */
export type SkillLocation = 'repo-local' | 'global' | 'explicit';

/**
 * Neura's view of a skill loaded from disk.
 *
 * Extends what pi-coding-agent's `Skill` type exposes (name, description,
 * filePath, etc.) with the two frontmatter fields pi parses but does not
 * surface on its type: `allowed-tools` and `metadata.*`. Neura's skill-loader
 * re-parses each SKILL.md to extract these after calling pi's `loadSkills()`.
 *
 * This type is intentionally runtime-neutral — no references to pi imports —
 * so `@neura/types` stays a zero-runtime-dep package.
 */
export interface NeuraSkill {
  /** Skill name from spec-required `name` frontmatter field */
  name: string;

  /** Human-readable description from spec-required `description` field */
  description: string;

  /** Absolute path to the SKILL.md file on disk */
  filePath: string;

  /**
   * Directory containing SKILL.md. Scripts, references, and other relative
   * assets resolve against this path.
   */
  baseDir: string;

  /**
   * Where this skill was loaded from. Used for shadow resolution and
   * diagnostic reporting.
   */
  location: SkillLocation;

  /**
   * Whether pi's `formatSkillsForPrompt()` filter should exclude this skill
   * from the LLM catalog. Mirrors the spec's `disable-model-invocation`
   * boolean frontmatter field. True means "loaded but draft" — visible to
   * `list_skills` but not auto-invocable.
   */
  disableModelInvocation: boolean;

  /**
   * Tools this skill is permitted to call, parsed from the space-delimited
   * `allowed-tools` frontmatter field. Empty array means the field was
   * absent — see the "`allowed-tools` absence policy" in the design doc for
   * what happens at execution time (Neura applies a read-only default set).
   */
  allowedTools: string[];

  /**
   * Whether the SKILL.md explicitly declared `allowed-tools`. Distinct from
   * `allowedTools.length === 0` because an author may declare an empty
   * allowlist intentionally.
   */
  hasExplicitAllowedTools: boolean;

  /**
   * Arbitrary nested key-value mapping from the spec's `metadata` frontmatter
   * field. Neura uses nested keys like `metadata.neura_source` for origin
   * tracking. Other runtimes silently ignore keys they don't recognize.
   */
  metadata: Record<string, unknown>;

  /** Markdown body (everything after the YAML frontmatter). */
  body: string;
}

/**
 * Result of loading skills from a set of paths. Mirrors pi's `LoadSkillsResult`
 * but returns `NeuraSkill` objects instead of pi's thinner `Skill` type.
 */
export interface LoadSkillsResult {
  skills: NeuraSkill[];
  diagnostics: SkillDiagnostic[];
}

/**
 * Non-fatal warning emitted during skill loading. Pi emits validation
 * warnings as diagnostics; Neura adds its own (e.g. "skill has no
 * allowed-tools field, will run in minimal-capability mode").
 */
export interface SkillDiagnostic {
  type: 'warning' | 'error';
  message: string;
  /** Path to the SKILL.md file the diagnostic is about, if applicable */
  path?: string;
}
