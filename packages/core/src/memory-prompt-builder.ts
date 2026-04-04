import type { MemoryContext } from '@neura/types';

/**
 * Build a system prompt string from memory context.
 * Sections are assembled in priority order; empty sections are omitted.
 */
export function buildMemoryPrompt(context: MemoryContext): string {
  const sections: string[] = [];

  // 1. Identity — base_personality is the opening line, others are behavioral rules
  if (context.identity.length > 0) {
    const personality = context.identity.find((e) => e.attribute === 'base_personality');
    if (personality) sections.push(personality.value);

    const rules = context.identity.filter((e) => e.attribute !== 'base_personality');
    for (const rule of rules) {
      sections.push(`${formatAttribute(rule.attribute)}: ${rule.value}`);
    }
  }

  // 2. Tool instructions (static)
  sections.push(
    "You can see through the user's camera using the describe_camera tool.",
    "You can see the user's shared screen using the describe_screen tool.",
    'When the user asks you to look at something physical, use describe_camera.',
    'When they ask about their screen, code, or display, use describe_screen.'
  );

  // 3. Preferences
  if (context.preferences.length > 0) {
    sections.push('\nUser preferences:');
    for (const pref of context.preferences) {
      const emphasis = pref.strength >= 1.5 ? ' (strongly prefers)' : '';
      sections.push(`- ${pref.preference}${emphasis}`);
    }
  }

  // 4. User profile
  if (context.userProfile.length > 0) {
    sections.push('\nAbout the user:');
    for (const field of context.userProfile) {
      sections.push(`- ${formatAttribute(field.field)}: ${field.value}`);
    }
  }

  // 5. Recent facts
  if (context.recentFacts.length > 0) {
    sections.push('\nThings you know:');
    for (const fact of context.recentFacts) {
      sections.push(`- [${fact.category}] ${fact.content}`);
    }
  }

  // 6. Session continuity
  if (context.recentSummaries.length > 0) {
    sections.push('\nRecent sessions:');
    for (const summary of context.recentSummaries) {
      const parts = [summary.summary];
      if (summary.topics.length > 0) {
        parts.push(`Topics: ${summary.topics.join(', ')}.`);
      }
      if (summary.openThreads.length > 0) {
        parts.push(`Open threads: ${summary.openThreads.join(', ')}.`);
      }
      sections.push(`- ${parts.join(' ')}`);
    }
  }

  return sections.join('\n');
}

/** Convert snake_case attribute name to Title Case */
function formatAttribute(attr: string): string {
  return attr
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}
