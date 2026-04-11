import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..', '..');
const serverSrc = join(here, 'server.ts');
const bundlePath = join(repoRoot, 'packages', 'core', 'dist', 'core', 'server.bundled.mjs');

describe('server entry point', () => {
  it('does NOT import dotenv/config as a top-level side effect', () => {
    // Regression guard: `import 'dotenv/config'` in server.ts runs
    // `dotenv.config()` as a startup side-effect, which reads `.env` from
    // the process CWD. In the bundled production server this is a real
    // bug — the user's CWD when they run `neura install` is arbitrary
    // (often some project directory), and any `.env` there will silently
    // override values from `$NEURA_HOME/config.json`. We diagnosed this
    // in the wild: a user hit `PORT=3000` in a repo `.env` overriding
    // their install's assigned port 18259, causing the CLI's health
    // check to time out because it polled the wrong port.
    //
    // For dev we use `src/server/dev-server.ts` which explicitly imports
    // dotenv/config BEFORE delegating to server.ts. This test makes sure
    // nobody accidentally re-adds the static import to server.ts.
    const src = readFileSync(serverSrc, 'utf-8');

    // Strip /* block comments */ and // line comments so the explanatory
    // comment at the top of server.ts — which legitimately mentions
    // `dotenv/config` in prose to explain WHY it was removed — doesn't
    // trip the guard. After stripping, we only see actual code.
    const withoutBlockComments = src.replace(/\/\*[\s\S]*?\*\//g, '');
    const withoutLineComments = withoutBlockComments
      .split('\n')
      .map((line) => line.replace(/\/\/.*$/, ''))
      .join('\n');

    expect(withoutLineComments).not.toMatch(/import\s+['"]dotenv\/config['"]/);
    expect(withoutLineComments).not.toMatch(/require\(['"]dotenv\/config['"]\)/);
    // Also forbid any other top-level import from dotenv — the dev-server
    // wrapper is the only place dotenv should be referenced.
    expect(withoutLineComments).not.toMatch(/from\s+['"]dotenv['"]/);
  });

  it.skipIf(!existsSync(bundlePath))('bundled output does not reference the dotenv package', () => {
    // Complementary guard at the build-artifact level: even if some
    // transitive dependency pulls in dotenv through a require chain
    // that TypeScript can't see, the built bundle should be free of
    // it. Runs only when the bundle exists (after `npm run build`) so
    // the test stays cheap in normal dev loops.
    const bundled = readFileSync(bundlePath, 'utf-8');
    // `dotenv` as a word — the string literal appears nowhere in the
    // bundled output (no package name, no error messages, no license
    // header). Tree-shaking should have removed it entirely.
    expect(bundled).not.toMatch(/\bdotenv\b/);
  });
});
