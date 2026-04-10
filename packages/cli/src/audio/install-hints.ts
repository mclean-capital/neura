/**
 * Install hint helper for optional native audio dependencies.
 *
 * Detects whether the CLI is running from a global npm install or from a
 * monorepo workspace, and returns the appropriate install instructions.
 */

function isGlobalInstall(): boolean {
  try {
    // If we're inside node_modules/@mclean-capital/*, we're an npm package.
    // Otherwise we're running from the monorepo (tsx src/ or dist/).
    return import.meta.url.includes('node_modules') && import.meta.url.includes('mclean-capital');
  } catch {
    return false;
  }
}

/**
 * Build an install hint for a missing optional dependency.
 * Shows instructions appropriate to the user's context (global vs workspace).
 */
export function audioInstallHint(depName: string): string {
  if (isGlobalInstall()) {
    return (
      'If installed globally via npm, retry with optional deps enabled:\n' +
      '  npm install -g @mclean-capital/neura --include=optional\n' +
      `This requires a C++ build toolchain for ${depName} (Python + gcc/clang/MSVC).`
    );
  }
  return `npm install ${depName} -w @mclean-capital/neura`;
}
