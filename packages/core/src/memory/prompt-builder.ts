import type { MemoryContext, MemoryTierConfig } from '@neura/types';

const DEFAULT_TIER_CONFIG: MemoryTierConfig = {
  l0Budget: 300,
  l1Budget: 400,
  l2Budget: 700,
};

/**
 * Build a system prompt string from memory context.
 * Organized into tiers: L0 (identity), L1 (essential context), L2 (session context).
 * Each tier has a token budget; lower-priority content is trimmed first.
 */
export interface PromptBuildOptions {
  tierConfig?: MemoryTierConfig;
  /**
   * The configured assistant name (from `config.assistantName`).
   * Used to generate the base personality line dynamically so
   * changing the wake word also changes how the assistant introduces
   * itself. If omitted, falls back to reading `base_personality`
   * from the DB identity table (legacy path).
   */
  assistantName?: string;
}

export function buildMemoryPrompt(context: MemoryContext, options?: PromptBuildOptions): string {
  const config = options?.tierConfig ?? DEFAULT_TIER_CONFIG;
  const sections: string[] = [];

  // L0: Identity + tool instructions (always loaded)
  const l0 = buildL0(context, options?.assistantName);
  sections.push(...trimToTokenBudget(l0, config.l0Budget));

  // L1: User profile + top preferences (always loaded)
  const l1 = buildL1(context);
  sections.push(...trimToTokenBudget(l1, config.l1Budget));

  // L2: Recent facts + session summaries (session context)
  const l2 = buildL2(context);
  sections.push(...trimToTokenBudget(l2, config.l2Budget));

  return sections.join('\n');
}

/** L0: Identity — base personality and behavioral rules + static tool instructions. */
function buildL0(context: MemoryContext, assistantName?: string): string[] {
  const parts: string[] = [];

  // Inject the configured assistant name so the assistant's
  // self-identity stays in sync with the wake word. This is a
  // SEPARATE line from the DB `base_personality` — we prepend
  // "Your name is <Name>." rather than replacing the entire
  // personality string. That way any learned/customized personality
  // traits stored in the DB are preserved. If the DB base_personality
  // says "You are Neura, a sarcastic AI who loves dad jokes" and
  // the user changes assistantName to "Alfred", Grok sees:
  //
  //   Your name is Alfred.
  //   You are Neura, a sarcastic AI who loves dad jokes.
  //
  // Grok follows the explicit name declaration and adopts the
  // personality traits from the DB entry. Not perfectly clean
  // (the DB still says "Neura") but non-destructive — we never
  // silently drop personality customizations.
  if (assistantName) {
    const displayName = assistantName.charAt(0).toUpperCase() + assistantName.slice(1);
    parts.push(`Your name is ${displayName}.`);
  }

  // DB identity entries: base_personality + behavioral rules
  // (tone, verbosity, filler_words, etc.). All of these can be
  // learned/updated from conversations via the extraction pipeline,
  // which is why we read them from the DB rather than generating
  // them statically.
  if (context.identity.length > 0) {
    const personality = context.identity.find((e) => e.attribute === 'base_personality');
    if (personality) parts.push(personality.value);

    const rules = context.identity.filter((e) => e.attribute !== 'base_personality');
    for (const rule of rules) {
      parts.push(`${formatAttribute(rule.attribute)}: ${rule.value}`);
    }
  }

  // Static tool instructions
  parts.push(
    "You can see through the user's camera using the describe_camera tool.",
    "You can see the user's shared screen using the describe_screen tool.",
    'When the user asks you to look at something physical, use describe_camera.',
    'When they ask about their screen, code, or display, use describe_screen.'
  );

  return parts;
}

/** L1: Essential context — user profile + top preferences (strength > 1.5). */
function buildL1(context: MemoryContext): string[] {
  const parts: string[] = [];

  // Preferences (all of them, with emphasis for strong ones)
  if (context.preferences.length > 0) {
    parts.push('\nUser preferences:');
    for (const pref of context.preferences) {
      const emphasis = pref.strength >= 1.5 ? ' (strongly prefers)' : '';
      parts.push(`- ${pref.preference}${emphasis}`);
    }
  }

  // User profile
  if (context.userProfile.length > 0) {
    parts.push('\nAbout the user:');
    for (const field of context.userProfile) {
      parts.push(`- ${formatAttribute(field.field)}: ${field.value}`);
    }
  }

  return parts;
}

/** L2: Session context — recent facts grouped by tag_path + session summaries. */
function buildL2(context: MemoryContext): string[] {
  const parts: string[] = [];

  // Group facts by top-level tag_path segment
  if (context.recentFacts.length > 0) {
    parts.push('\nThings you know:');

    const grouped = new Map<string, typeof context.recentFacts>();
    for (const fact of context.recentFacts) {
      const topLevel = fact.tagPath?.split('.')[0] ?? fact.category;
      const group = grouped.get(topLevel) ?? [];
      group.push(fact);
      grouped.set(topLevel, group);
    }

    for (const [group, facts] of grouped) {
      if (grouped.size > 1) {
        parts.push(`  [${group}]`);
      }
      for (const fact of facts) {
        const label = fact.tagPath ?? fact.category;
        parts.push(`- [${label}] ${fact.content}`);
      }
    }
  }

  // Session continuity
  if (context.recentSummaries.length > 0) {
    parts.push('\nRecent sessions:');
    for (const summary of context.recentSummaries) {
      const summaryParts = [summary.summary];
      if (summary.topics.length > 0) {
        summaryParts.push(`Topics: ${summary.topics.join(', ')}.`);
      }
      if (summary.openThreads.length > 0) {
        summaryParts.push(`Open threads: ${summary.openThreads.join(', ')}.`);
      }
      parts.push(`- ${summaryParts.join(' ')}`);
    }
  }

  return parts;
}

/** Trim lines from the end until total estimated tokens fit within budget. */
function trimToTokenBudget(lines: string[], maxTokens: number): string[] {
  const estimateTokens = (text: string) => Math.ceil(text.length / 4);
  let total = lines.reduce((sum, line) => sum + estimateTokens(line), 0);

  while (total > maxTokens && lines.length > 1) {
    const removed = lines.pop()!;
    total -= estimateTokens(removed);
  }

  return lines;
}

/** Convert snake_case attribute name to Title Case */
function formatAttribute(attr: string): string {
  return attr
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}
