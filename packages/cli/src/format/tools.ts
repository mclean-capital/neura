import chalk from 'chalk';

const MAX_PREVIEW_LEN = 120;

function stringifyCompact(value: unknown): string {
  try {
    const str = JSON.stringify(value);
    if (!str) return '';
    if (str.length <= MAX_PREVIEW_LEN) return str;
    return str.slice(0, MAX_PREVIEW_LEN - 3) + '...';
  } catch {
    return String(value);
  }
}

function formatArgsInline(args: Record<string, unknown>): string {
  const entries = Object.entries(args);
  if (entries.length === 0) return '';
  const parts = entries.map(([k, v]) => `${k}=${stringifyCompact(v)}`);
  const joined = parts.join(' ');
  if (joined.length <= MAX_PREVIEW_LEN) return joined;
  return joined.slice(0, MAX_PREVIEW_LEN - 3) + '...';
}

/**
 * Format an incoming toolCall message for prominent display in the CLI.
 *
 * Example output:
 *   › tool enter_mode(mode="passive")
 */
export function formatToolCall(name: string, args: Record<string, unknown>): string {
  const argStr = formatArgsInline(args);
  return chalk.cyan(`  › tool ${name}`) + (argStr ? chalk.dim(`(${argStr})`) : '');
}

/**
 * Format an incoming toolResult message. Errors get red; successful results
 * are dim since they're mostly for transparency, not action.
 */
export function formatToolResult(name: string, result: Record<string, unknown>): string {
  const errorVal = (result as { error?: unknown }).error;
  if (errorVal !== undefined) {
    return chalk.red(`  ✗ ${name} error: ${stringifyCompact(errorVal)}`);
  }
  const preview = stringifyCompact(result);
  return chalk.dim(`  ← ${name} ${preview}`);
}
