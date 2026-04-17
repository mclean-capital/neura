import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import chalk from 'chalk';
import { loadSkills, parseFrontmatter } from '@mariozechner/pi-coding-agent';

const COMPATIBILITY_MAX_LENGTH = 500;

interface Diagnostic {
  type: 'warning' | 'error';
  message: string;
  path?: string;
}

/**
 * Validate a skill or directory of skills against the agentskills.io spec.
 *
 * Delegates core spec validation (name / description / character rules /
 * parent-dir match / frontmatter parse) to pi-coding-agent's loader, then
 * layers on Neura-specific checks for `license` and `compatibility` that
 * pi does not inspect.
 *
 * Any diagnostic — pi's warnings or Neura's — causes a non-zero exit.
 * Designed for skill authors who want a pre-commit / CI check that their
 * SKILL.md will load cleanly in Neura.
 */
export function skillValidateCommand(pathArg: string): void {
  const absPath = resolve(pathArg);
  const result = loadSkills({
    skillPaths: [absPath],
    includeDefaults: false,
  });

  const diagnostics: Diagnostic[] = result.diagnostics.map((d) => ({
    type: d.type === 'error' ? 'error' : 'warning',
    message: d.message,
    path: d.path,
  }));

  for (const skill of result.skills) {
    try {
      const raw = readFileSync(skill.filePath, 'utf8');
      const { frontmatter } = parseFrontmatter<Record<string, unknown>>(raw);
      diagnostics.push(...checkLicense(skill.name, skill.filePath, frontmatter.license));
      diagnostics.push(
        ...checkCompatibility(skill.name, skill.filePath, frontmatter.compatibility)
      );
    } catch (err) {
      diagnostics.push({
        type: 'error',
        message: `Failed to re-parse frontmatter: ${String(err)}`,
        path: skill.filePath,
      });
    }
  }

  console.log(`${result.skills.length} skill(s) found at ${pathArg}`);

  if (result.skills.length === 0 && diagnostics.length === 0) {
    console.log(chalk.red('  ✗ No SKILL.md found — nothing to validate'));
    process.exit(1);
  }

  const errors = diagnostics.filter((d) => d.type === 'error');
  const warnings = diagnostics.filter((d) => d.type === 'warning');

  if (errors.length === 0 && warnings.length === 0) {
    console.log(chalk.green('  ✓ All skills pass agentskills.io spec validation'));
    return;
  }

  if (errors.length > 0) {
    console.log(chalk.red(`\n${errors.length} error(s):`));
    for (const e of errors) {
      console.log(chalk.red(`  ✗ ${e.message}`));
      if (e.path) console.log(chalk.dim(`    ${e.path}`));
    }
  }

  if (warnings.length > 0) {
    console.log(chalk.yellow(`\n${warnings.length} warning(s):`));
    for (const w of warnings) {
      console.log(chalk.yellow(`  ⚠ ${w.message}`));
      if (w.path) console.log(chalk.dim(`    ${w.path}`));
    }
  }

  process.exit(1);
}

function checkLicense(skillName: string, filePath: string, raw: unknown): Diagnostic[] {
  if (raw === undefined) return [];
  if (typeof raw !== 'string') {
    return [
      {
        type: 'warning',
        message: `Skill '${skillName}' has 'license' field of type ${typeof raw}; agentskills.io spec requires a string.`,
        path: filePath,
      },
    ];
  }
  return [];
}

function checkCompatibility(skillName: string, filePath: string, raw: unknown): Diagnostic[] {
  if (raw === undefined) return [];
  if (typeof raw !== 'string') {
    return [
      {
        type: 'warning',
        message: `Skill '${skillName}' has 'compatibility' field of type ${typeof raw}; agentskills.io spec requires a string.`,
        path: filePath,
      },
    ];
  }
  if (raw.length > COMPATIBILITY_MAX_LENGTH) {
    return [
      {
        type: 'warning',
        message: `Skill '${skillName}' has 'compatibility' field of ${raw.length} characters; agentskills.io spec caps at ${COMPATIBILITY_MAX_LENGTH}.`,
        path: filePath,
      },
    ];
  }
  return [];
}

export const __test__ = { checkLicense, checkCompatibility };
