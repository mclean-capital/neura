// Dev-only entry point for the core server.
//
// The production bundle (`dist/core/server.bundled.mjs`) is built from
// `server.ts` directly and intentionally does NOT load a .env file —
// see the comment at the top of `server.ts` for why. During local
// development we DO want dotenv so `packages/core/.env` picks up API
// keys and ports from the repo. This wrapper adds that side-effect
// import and then delegates to the real entry point.
//
// Both `npm run dev` and `npm run start` in `packages/core/package.json`
// target this file instead of `server.ts`.
import 'dotenv/config';
import './server.js';
