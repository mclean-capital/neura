/**
 * Phase 6 — Skill registry
 *
 * In-memory index of loaded NeuraSkills keyed by name. Serves three consumers:
 *
 * 1. `list_skills` / `get_skill` tools — surface what's installed, including
 *    draft skills (for introspection), via `list()` and `get()`.
 *
 * 2. Grok system prompt construction — `getPromptContext(budgetTokens)`
 *    delegates to pi's `formatSkillsForPrompt()` (which already filters
 *    draft skills per `disable-model-invocation`) and wraps a token-budget
 *    layer on top with MRU eviction when the catalog overflows.
 *
 * 3. `beforeToolCall` permission enforcement — `getAllowedTools(name)`
 *    returns the parsed `allowed-tools` list (or the Neura default if the
 *    skill didn't declare it), consumed by pi-runtime's per-skill hook.
 *
 * MRU tracking: the registry maintains an in-memory `lastUsedAt` map. A
 * persistent skill_usage table lives separately in the store layer; the
 * registry exposes `notifyUsed()` hooks so a future wiring step can mirror
 * usage into PGlite without coupling the registry to the database.
 */

import { formatSkillsForPrompt, type Skill as PiSkill } from '@mariozechner/pi-coding-agent';
import { Logger } from '@neura/utils/logger';
import type { NeuraSkill } from '@neura/types';
import { MINIMAL_DEFAULT_ALLOWED_TOOLS } from './skill-loader.js';

const log = new Logger('skill-registry');

/**
 * Approximate token-to-character ratio used for the soft prompt budget.
 * GPT-family tokenizers average ~4 characters per token on English prose.
 * This is a placeholder — see the "Skill registry `getPromptContext()`"
 * section in docs/phase6-os-core.md for the intended tokenizer. We'll swap
 * in a real tokenizer when cost tracking needs one.
 */
const CHARS_PER_TOKEN_ESTIMATE = 4;

/**
 * Callback the registry fires whenever a skill is marked as used. Plug in a
 * persistent store writer (skill-usage-queries) in the wiring step — this
 * keeps the registry store-agnostic.
 */
export type SkillUsageListener = (name: string, timestamp: number) => void;

export interface SkillRegistryOptions {
  /** Optional listener fired on notifyUsed() — typically wired to the skill_usage table. */
  onSkillUsed?: SkillUsageListener;
}

export class SkillRegistry {
  private readonly onSkillUsed?: SkillUsageListener;
  private skillsByName = new Map<string, NeuraSkill>();
  // MRU — monotonically increasing counter per-use, so even ties in ts get ordered.
  private lastUsedAt = new Map<string, number>();
  private useCounter = 0;

  constructor(options: SkillRegistryOptions = {}) {
    this.onSkillUsed = options.onSkillUsed;
  }

  /**
   * Replace the entire registry with a new set of skills. Called by the
   * initial load path and by `skill-watcher` on hot-reload. Existing MRU
   * state is preserved for skills that survive the reload — only pruned
   * for skills that no longer exist.
   */
  replaceAll(skills: NeuraSkill[]): void {
    const nextNames = new Set(skills.map((s) => s.name));

    // Prune MRU entries for skills that were removed.
    for (const name of this.lastUsedAt.keys()) {
      if (!nextNames.has(name)) this.lastUsedAt.delete(name);
    }

    this.skillsByName = new Map(skills.map((s) => [s.name, s]));
    log.info('registry updated', { count: skills.length });
  }

  /** Number of skills currently loaded (including drafts). */
  get size(): number {
    return this.skillsByName.size;
  }

  /**
   * Return every loaded skill (including drafts). `list_skills` tool uses
   * this — drafts should be visible for introspection even though they're
   * excluded from the model-facing catalog.
   */
  list(): NeuraSkill[] {
    return Array.from(this.skillsByName.values());
  }

  /** Single skill by name, or undefined if unknown. */
  get(name: string): NeuraSkill | undefined {
    return this.skillsByName.get(name);
  }

  /** Check whether a skill is registered (and not filtered). */
  has(name: string): boolean {
    return this.skillsByName.has(name);
  }

  /**
   * Return the `allowed-tools` list a worker may invoke when running this
   * skill. If the skill declared `allowed-tools` explicitly, that list is
   * returned. If not, the Neura minimal default tool set applies — see the
   * "`allowed-tools` absence policy" in the design doc.
   *
   * Returns undefined if the skill itself is unknown — callers should treat
   * that as a hard refusal (don't silently fall back to any tool set).
   */
  getAllowedTools(name: string): readonly string[] | undefined {
    const skill = this.skillsByName.get(name);
    if (!skill) return undefined;
    return skill.hasExplicitAllowedTools ? skill.allowedTools : MINIMAL_DEFAULT_ALLOWED_TOOLS;
  }

  /**
   * Record that a skill was used. Bumps the in-memory MRU counter (for
   * `getPromptContext()` eviction order) and fires the optional listener
   * so a persistent store can mirror the event.
   */
  notifyUsed(name: string): void {
    if (!this.skillsByName.has(name)) return;
    this.useCounter += 1;
    this.lastUsedAt.set(name, this.useCounter);
    const ts = Date.now();
    if (this.onSkillUsed) {
      try {
        this.onSkillUsed(name, ts);
      } catch (err) {
        log.warn('onSkillUsed listener threw', { name, err: String(err) });
      }
    }
  }

  /**
   * Build the skill catalog string injected into Grok's system prompt.
   *
   * Pipeline:
   *   1. Filter to non-draft skills (pi's `formatSkillsForPrompt` already
   *      excludes skills with `disable-model-invocation: true`, so passing
   *      the full list is fine)
   *   2. Rank by MRU (most-recently-used first, never-used skills last in
   *      stable list order) so the budget-fitting step evicts the oldest
   *   3. Greedily include skills from the head of the ranked list until
   *      the estimated token budget is reached
   *   4. Hand the surviving pi-Skill shapes to pi's formatter
   *
   * Returns the formatted prompt string (empty if no skills fit or none
   * are model-invocable). Budget overflow is silent — the caller is
   * expected to have already reserved space for memory injection etc.
   */
  getPromptContext(budgetTokens: number): string {
    if (budgetTokens <= 0 || this.skillsByName.size === 0) return '';

    // Skills available to the model (drop drafts — pi's formatter would
    // filter them anyway, but ranking works on the pre-filtered list so
    // we don't spend MRU slots on things that can't run).
    const candidates = this.list().filter((s) => !s.disableModelInvocation);
    if (candidates.length === 0) return '';

    // MRU ranking: skills with a lastUsedAt counter win, descending; ties
    // break by alphabetical name for determinism; never-used skills trail.
    const ranked = [...candidates].sort((a, b) => {
      const au = this.lastUsedAt.get(a.name) ?? 0;
      const bu = this.lastUsedAt.get(b.name) ?? 0;
      if (au !== bu) return bu - au;
      return a.name.localeCompare(b.name);
    });

    // Greedy budget fit. Format each candidate in isolation to get an
    // approximate cost, then include until the budget is exhausted. The
    // exact cost when pi formats the final list together may differ
    // slightly (XML wrapper overhead), so we under-commit by 10%.
    const effectiveBudgetChars = Math.floor(budgetTokens * CHARS_PER_TOKEN_ESTIMATE * 0.9);
    const accepted: NeuraSkill[] = [];
    let usedChars = 0;

    for (const skill of ranked) {
      const cost = estimateSkillPromptCost(skill);
      if (usedChars + cost > effectiveBudgetChars && accepted.length > 0) {
        // Over budget and we already have at least one skill — stop.
        log.info('prompt budget exhausted, evicting remaining skills', {
          included: accepted.length,
          remaining: ranked.length - accepted.length,
          usedChars,
          budgetChars: effectiveBudgetChars,
        });
        break;
      }
      accepted.push(skill);
      usedChars += cost;
    }

    // Translate back to pi's Skill shape and let pi format.
    // We pass the pi shape (pi's formatter doesn't care about our extra
    // fields anyway — it only reads name, description, disableModelInvocation).
    const piSkills = accepted.map(toPiSkillShape);
    return formatSkillsForPrompt(piSkills);
  }
}

/**
 * Roughly estimate the character cost of including a single skill in the
 * prompt catalog. Pi's formatter uses an XML block per skill with name +
 * description; a tight upper bound is name + description + ~50 chars of
 * XML boilerplate. Exported for testing.
 */
export function estimateSkillPromptCost(skill: NeuraSkill): number {
  return skill.name.length + skill.description.length + 50;
}

/**
 * Project a NeuraSkill back onto pi's Skill shape for the formatter.
 * Pi's Skill interface only needs name / description / filePath / baseDir /
 * sourceInfo / disableModelInvocation; custom fields (allowed-tools,
 * metadata.*) aren't read. We reconstruct a minimal sourceInfo because
 * NeuraSkill doesn't carry pi's internal shape.
 */
function toPiSkillShape(skill: NeuraSkill): PiSkill {
  return {
    name: skill.name,
    description: skill.description,
    filePath: skill.filePath,
    baseDir: skill.baseDir,
    sourceInfo: {
      path: skill.baseDir,
      source: skill.location,
      scope: skill.location === 'repo-local' ? 'project' : 'user',
      origin: 'top-level',
    },
    disableModelInvocation: skill.disableModelInvocation,
  };
}
