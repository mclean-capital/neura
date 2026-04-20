## [3.6.1](https://github.com/mclean-capital/neura/compare/v3.6.0...v3.6.1) (2026-04-20)

### Bug Fixes

- **voice:** batch tool dispatch on response.done to stop monologue ([e944ae9](https://github.com/mclean-capital/neura/commit/e944ae901e68bfe108ad558f7ce1801cb77c2bfd))

# [3.6.0](https://github.com/mclean-capital/neura/compare/v3.5.4...v3.6.0) (2026-04-20)

### Features

- **core:** read_log tool — scoped log inspection for the orchestrator ([ee8db29](https://github.com/mclean-capital/neura/commit/ee8db29ba05b3497beea8be17e6067a60defec1e))

## [3.5.4](https://github.com/mclean-capital/neura/compare/v3.5.3...v3.5.4) (2026-04-20)

### Bug Fixes

- **core:** await onAnswer before resolving clarification; guard post-consume abort ([8470ca1](https://github.com/mclean-capital/neura/commit/8470ca13c26923c9cdfc51e64d72034e2ad5af03))

## [3.5.3](https://github.com/mclean-capital/neura/compare/v3.5.2...v3.5.3) (2026-04-20)

### Bug Fixes

- **core:** apply review round — comment sort, heartbeat prune, UUID redaction, skill ship ([3e8a49e](https://github.com/mclean-capital/neura/commit/3e8a49e1f61704ab67f603ac859f4ed60a9aeace))

## [3.5.2](https://github.com/mclean-capital/neura/compare/v3.5.1...v3.5.2) (2026-04-20)

### Bug Fixes

- **core:** surface worker comments in get_task, drop UUID from dispatch_worker ([d296c54](https://github.com/mclean-capital/neura/commit/d296c54617ccd5d63191b21a88784a77ba4572dd))

## [3.5.1](https://github.com/mclean-capital/neura/compare/v3.5.0...v3.5.1) (2026-04-20)

### Bug Fixes

- **core:** wire Neura provider keys into pi + surface worker errors ([ef48615](https://github.com/mclean-capital/neura/commit/ef48615e1629ae8d78fe3dad5b32b77b2fea5f08))

# [3.5.0](https://github.com/mclean-capital/neura/compare/v3.4.1...v3.5.0) (2026-04-19)

### Bug Fixes

- **core:** Phase 6b review round 2 — 7 findings from subagent + Codex ([136495b](https://github.com/mclean-capital/neura/commit/136495bbb15687cda03bc5bae658b767eedb1e1a)), closes [#1](https://github.com/mclean-capital/neura/issues/1) [#2](https://github.com/mclean-capital/neura/issues/2) [#3](https://github.com/mclean-capital/neura/issues/3) [#4](https://github.com/mclean-capital/neura/issues/4) [#5](https://github.com/mclean-capital/neura/issues/5) [#6](https://github.com/mclean-capital/neura/issues/6) [#7](https://github.com/mclean-capital/neura/issues/7)
- **core:** Wave 3 Pass 1 nits — filter handling + Pass 2 prerequisites ([c5fa99c](https://github.com/mclean-capital/neura/commit/c5fa99c05e09aceba3f1bb09c744480b466b23e1))

### Features

- **cli:** add neura skill validate command ([f1f0214](https://github.com/mclean-capital/neura/commit/f1f02142eadbad0d55580286dc5a1f7f6422ebeb))
- **core:** surface license + compatibility on skills (agentskills.io spec) ([ddd9ee1](https://github.com/mclean-capital/neura/commit/ddd9ee1d0381663325a77227259261920b40d70c))
- **core:** Wave 2 — schema migration for task-driven execution ([5df5e2e](https://github.com/mclean-capital/neura/commit/5df5e2ef510dd4e86d3a1252edbc01fd93a03b43))
- **core:** Wave 3 Pass 1 — orchestrator task-driven tool surface ([6967af9](https://github.com/mclean-capital/neura/commit/6967af98a9af67521bb0179288e301621636dae6))
- **core:** Wave 3 Pass 2 — dispatch wiring + invariant layer ([39dd5fb](https://github.com/mclean-capital/neura/commit/39dd5fbb96a30cafac796b9f7d7ac8cdef5fadc1))
- **core:** Wave 3 Pass 3 — 6-verb worker protocol tools ([f1713f6](https://github.com/mclean-capital/neura/commit/f1713f645434002b51b97b9f7ae6ccf195f48d11))
- **core:** Wave 4 — worktrees + canonical worker prompt ([2f3c1a1](https://github.com/mclean-capital/neura/commit/2f3c1a15c028556d3b3c08564b4c7604936b1cd5))

## [3.4.1](https://github.com/mclean-capital/neura/compare/v3.4.0...v3.4.1) (2026-04-14)

### Bug Fixes

- **cli:** check isRunning() before stopping service during install ([9fc4586](https://github.com/mclean-capital/neura/commit/9fc458631d7aa807d3986f1f5b647cafd0b51ba2))

# [3.4.0](https://github.com/mclean-capital/neura/compare/v3.3.0...v3.4.0) (2026-04-14)

### Features

- **cli:** add Vercel AI Gateway as a provider option ([4981480](https://github.com/mclean-capital/neura/commit/4981480736f8096c7a546fba89829c2983124ed9))

# [3.3.0](https://github.com/mclean-capital/neura/compare/v3.2.0...v3.3.0) (2026-04-14)

### Features

- **cli:** model-agnostic setup wizard with feature-based provider selection ([2943afa](https://github.com/mclean-capital/neura/commit/2943afaa96a55bf221912456b7ca38628d664692))

# [3.2.0](https://github.com/mclean-capital/neura/compare/v3.1.0...v3.2.0) (2026-04-13)

### Features

- **cli:** pvrecorder fallback for mic capture on Intel Mac ([a27da3f](https://github.com/mclean-capital/neura/commit/a27da3fef51724e094e3f1e984da219d661031b5)), closes [decibri/decibri#15](https://github.com/decibri/decibri/issues/15)

# [3.1.0](https://github.com/mclean-capital/neura/compare/v3.0.0...v3.1.0) (2026-04-13)

### Features

- **core:** add ONNX native → WASM fallback for intel mac wake word support ([37fcf01](https://github.com/mclean-capital/neura/commit/37fcf01270b86996d0dc9738d491da2afdadee4b))

# [3.0.0](https://github.com/mclean-capital/neura/compare/v2.4.2...v3.0.0) (2026-04-12)

### Bug Fixes

- **core:** pipeline session labels show actual providers + fallback detection ([38cd49c](https://github.com/mclean-capital/neura/commit/38cd49c743511c78000dcb1fcbfa025e0e30225f))
- **core:** pipeline voice review fixes — interruption, serialization, correctness ([4171179](https://github.com/mclean-capital/neura/commit/4171179c7e410b2520fc66223915e8cce11e957d))
- **core:** snapshot vision uses dedicated route adapter + fail-fast guard ([eddf900](https://github.com/mclean-capital/neura/commit/eddf90006b074be0cceacfff22ab7e19d69376df))

### Features

- **core:** dynamic embedding dimensions with \_meta tracking (Phase 2) ([01cb3d4](https://github.com/mclean-capital/neura/commit/01cb3d4ae64612cc742f2e4ae5210ed432cd9e0a))
- **core:** dynamic session recording + cost tracking (Phase 6) ([79c5fb1](https://github.com/mclean-capital/neura/commit/79c5fb170b354fb6da2fcb1a64a70e12f296a0a4))
- **core:** model-agnostic provider registry and adapter layer (Phase 1) ([c875b47](https://github.com/mclean-capital/neura/commit/c875b47a2ae6de5a8a5333f5cddcd424fe94afe7))
- **core:** pipeline voice mode — STT → LLM → TTS (Phase 3) ([19e47c0](https://github.com/mclean-capital/neura/commit/19e47c0573297bf091a22bff6fd0139426d5cf61))
- **core:** provider extraction — Grok voice + Gemini vision accept RouteDescriptor (Phases 4 & 5) ([c957a30](https://github.com/mclean-capital/neura/commit/c957a3015915641565166c89b958bbc2911d8037))

### BREAKING CHANGES

- **core:** Config schema changed from v2 (apiKeys.xai/google) to v3
  (providers map + capability-based routing). No migration path — users must
  update ~/.neura/config.json to the new format.

Phase 1 of the model-agnostic refactor introduces:

- Adapter interfaces in @neura/types: TextAdapter, EmbeddingAdapter,
  STT/TTS/Vision (split streaming/snapshot), VoiceInterjector,
  RouteDescriptor, AdapterPricing
- Zod-validated v3 config schema with optional routing (graceful
  degradation for partial setups), provider cross-reference validation,
  v2 detection with upgrade instructions, and env var overrides
  (NEURA*PROVIDER*_, NEURA*ROUTING*_ with numeric coercion)
- ProviderRegistry with KNOWN_BASE_URLS for google/xai/openrouter,
  route resolution returning null for unconfigured capabilities,
  singleton text/embedding adapters, per-session factory stubs
- OpenAI-compatible text adapter (chat, chatStream, chatWithTools,
  chatWithToolsStream with safeParseArgs) covering OpenAI, OpenRouter,
  Vercel AI Gateway, xAI, Google via baseUrl switching
- OpenAI-compatible embedding adapter with configurable dimensions
- Refactored ExtractionPipeline, Reranker, DiscoveryLoop to accept
  TextAdapter/EmbeddingAdapter instead of GoogleGenAI
- Updated lifecycle.ts with registry wiring, adapter null guards,
  configurable worker model routing via pi-ai
- CLI config rewritten for v3 schema with dynamic redaction
- Desktop CoreManager writes v3 config.json with conditional routing
- All 337 tests migrated and passing

## [2.4.2](https://github.com/mclean-capital/neura/compare/v2.4.1...v2.4.2) (2026-04-12)

### Bug Fixes

- **skills:** add read to red-test-triage allowed-tools ([2092ce9](https://github.com/mclean-capital/neura/commit/2092ce9b414064edd2b99168f256ef68642d1bf2))

## [2.4.1](https://github.com/mclean-capital/neura/compare/v2.4.0...v2.4.1) (2026-04-12)

### Bug Fixes

- **core:** default wake word back to jarvis — neura is too hard to pronounce ([1f2ac69](https://github.com/mclean-capital/neura/commit/1f2ac69db052db8e8a2ff852e828f7304afa5325))

# [2.4.0](https://github.com/mclean-capital/neura/compare/v2.3.0...v2.4.0) (2026-04-12)

### Features

- **cli:** bundle web UI in npm package for out-of-box neura open ([9b2bb1f](https://github.com/mclean-capital/neura/commit/9b2bb1f2fb822668a489326364eb0116157d37bd))

# [2.3.0](https://github.com/mclean-capital/neura/compare/v2.2.5...v2.3.0) (2026-04-12)

### Features

- **core,skills:** Phase 6 — Neura OS Core (pi-runtime workers + skills + orchestrator) ([#10](https://github.com/mclean-capital/neura/issues/10)) ([1b0ba2b](https://github.com/mclean-capital/neura/commit/1b0ba2b5d0a7c9bcff0b60668441f8dacbcc1d74)), closes [#1](https://github.com/mclean-capital/neura/issues/1) [#2](https://github.com/mclean-capital/neura/issues/2) [#4ab](https://github.com/mclean-capital/neura/issues/4ab) [#4c](https://github.com/mclean-capital/neura/issues/4c) [#4d](https://github.com/mclean-capital/neura/issues/4d) [#4e](https://github.com/mclean-capital/neura/issues/4e) [#4d](https://github.com/mclean-capital/neura/issues/4d) [#4e](https://github.com/mclean-capital/neura/issues/4e) [#4](https://github.com/mclean-capital/neura/issues/4) [#4e](https://github.com/mclean-capital/neura/issues/4e) [#4e](https://github.com/mclean-capital/neura/issues/4e) [#4c](https://github.com/mclean-capital/neura/issues/4c) [#4e](https://github.com/mclean-capital/neura/issues/4e)

## [2.2.5](https://github.com/mclean-capital/neura/compare/v2.2.4...v2.2.5) (2026-04-12)

### Bug Fixes

- **core:** default wake word to neura and sync assistant name with system prompt ([9c8b404](https://github.com/mclean-capital/neura/commit/9c8b4043ffededc5d556edfcf539c9d6c5611a1e))

## [2.2.4](https://github.com/mclean-capital/neura/compare/v2.2.3...v2.2.4) (2026-04-12)

### Bug Fixes

- **core:** use byte-based replay buffer so full wake utterance reaches Grok ([79a5057](https://github.com/mclean-capital/neura/commit/79a50579658b3418278d286c84268c940396f755))

## [2.2.3](https://github.com/mclean-capital/neura/compare/v2.2.2...v2.2.3) (2026-04-12)

### Bug Fixes

- **cli:** block neura config set assistantName when no matching classifier exists ([aef3aaa](https://github.com/mclean-capital/neura/commit/aef3aaa31a8611e6dd72d96f34eccf290ca8da7c))

## [2.2.2](https://github.com/mclean-capital/neura/compare/v2.2.1...v2.2.2) (2026-04-12)

### Bug Fixes

- **cli:** validate assistantName against available classifiers and show available wake words ([4970b24](https://github.com/mclean-capital/neura/commit/4970b2446ad3ceb30ed1b8a080da75ec595315f4))

## [2.2.1](https://github.com/mclean-capital/neura/compare/v2.2.0...v2.2.1) (2026-04-12)

### Bug Fixes

- **core,cli:** tell the client when wake detection is unavailable ([9a449a3](https://github.com/mclean-capital/neura/commit/9a449a38b98db7b7b1562a7ea874da59ff409f20))

# [2.2.0](https://github.com/mclean-capital/neura/compare/v2.1.7...v2.2.0) (2026-04-12)

### Features

- **cli:** ship wake-word ONNX models so fresh installs get working voice out of the box ([74ffd91](https://github.com/mclean-capital/neura/commit/74ffd914e8b93ce8462486c6c839056dc0cb7556))

## [2.1.7](https://github.com/mclean-capital/neura/compare/v2.1.6...v2.1.7) (2026-04-12)

### Bug Fixes

- **core:** buffer audio during voice session activation so wake utterance isn't lost ([bf06c58](https://github.com/mclean-capital/neura/commit/bf06c58ec44bd65741623b4b238d240880a59c06))

## [2.1.6](https://github.com/mclean-capital/neura/compare/v2.1.5...v2.1.6) (2026-04-12)

### Bug Fixes

- **cli:** stop core before npm install in neura update to avoid EPERM ([103df6e](https://github.com/mclean-capital/neura/commit/103df6e6fe2fb1a6aaca15c69aac6a99083fd481))

## [2.1.5](https://github.com/mclean-capital/neura/compare/v2.1.4...v2.1.5) (2026-04-12)

### Bug Fixes

- **core:** keep wake detector alive across active mode so second wake fires ([f56fd82](https://github.com/mclean-capital/neura/commit/f56fd82808a6e1181690ffd3e4cf1c41cd869b22)), closes [hi#score](https://github.com/hi/issues/score)

## [2.1.4](https://github.com/mclean-capital/neura/compare/v2.1.3...v2.1.4) (2026-04-11)

### Bug Fixes

- **cli:** pass ArrayBuffer (not number[]) to pvspeaker.write in neura listen ([5d460f2](https://github.com/mclean-capital/neura/commit/5d460f239a6fd01740de74e43397c580f27dfd2b))

## [2.1.3](https://github.com/mclean-capital/neura/compare/v2.1.2...v2.1.3) (2026-04-11)

### Bug Fixes

- **cli:** stop Windows terminal popup on neura start / neura install ([0bc9a8b](https://github.com/mclean-capital/neura/commit/0bc9a8b0fdfc9e4b1d8421d53b42ac52301db67b))

## [2.1.2](https://github.com/mclean-capital/neura/compare/v2.1.1...v2.1.2) (2026-04-11)

### Bug Fixes

- **cli:** silence DEP0190 deprecation warning in neura update ([87c868b](https://github.com/mclean-capital/neura/commit/87c868bf6645f5dcffd25618c30d6e9e745e052c))

## [2.1.1](https://github.com/mclean-capital/neura/compare/v2.1.0...v2.1.1) (2026-04-11)

### Bug Fixes

- **core:** don't load .env from CWD in the bundled production server ([7be9783](https://github.com/mclean-capital/neura/commit/7be9783e02ec5716447f39187e4cca85a7ac58f6))

# [2.1.0](https://github.com/mclean-capital/neura/compare/v2.0.0...v2.1.0) (2026-04-11)

### Features

- **cli:** real Windows service support via Scheduled Task + Startup fallback ([e9d5e2e](https://github.com/mclean-capital/neura/commit/e9d5e2e32b537f2ee28a0f9827fdf071679da8ba))

# [2.0.0](https://github.com/mclean-capital/neura/compare/v1.10.2...v2.0.0) (2026-04-11)

- feat(cli,core)!: ship core inside the CLI npm package ([c5d069a](https://github.com/mclean-capital/neura/commit/c5d069abcd370e5aede2e870b96eb8ddf2cae701))

### BREAKING CHANGES

- Users on v1.10.x cannot self-update to v1.11.0 via
  `neura update` (it still points at the defunct GitHub tarball path).
  Bootstrap once with `npm install -g @mclean-capital/neura@latest &&
neura install`. All future upgrades work normally via `neura update`.

## [1.10.2](https://github.com/mclean-capital/neura/compare/v1.10.1...v1.10.2) (2026-04-11)

### Bug Fixes

- **cli:** always rewrite service definition on neura install ([0845ac4](https://github.com/mclean-capital/neura/commit/0845ac476345d3a7336107b93d4a9902f6924119))

## [1.10.1](https://github.com/mclean-capital/neura/compare/v1.10.0...v1.10.1) (2026-04-11)

### Bug Fixes

- **cli:** launch core via Node binary in macOS launchd and Linux systemd ([9692a5f](https://github.com/mclean-capital/neura/commit/9692a5fdc51bd02bd2b8a2bdd87cf6229268f15d))

# [1.10.0](https://github.com/mclean-capital/neura/compare/v1.9.0...v1.10.0) (2026-04-10)

### Features

- **cli:** rename to @mclean-capital/neura, prep for npm publish ([f03de2c](https://github.com/mclean-capital/neura/commit/f03de2c362227839ddea2d4bd17365ae1ed5766d))

# [1.9.0](https://github.com/mclean-capital/neura/compare/v1.8.0...v1.9.0) (2026-04-10)

### Features

- **cli:** add text chat and voice listen client commands ([#9](https://github.com/mclean-capital/neura/issues/9)) ([86b60ac](https://github.com/mclean-capital/neura/commit/86b60acce9cf518408cd0ea87a5b656db6d598f8))

# [1.8.0](https://github.com/mclean-capital/neura/compare/v1.7.0...v1.8.0) (2026-04-10)

### Features

- **core,cli,desktop:** add shared-secret auth, localhost binding, and security hardening ([7a768f4](https://github.com/mclean-capital/neura/commit/7a768f438b3a26ac49e93fb1a82a00d08cd17237))

# [1.7.0](https://github.com/mclean-capital/neura/compare/v1.6.0...v1.7.0) (2026-04-10)

### Features

- **core:** on-device ONNX wake word detection ([#8](https://github.com/mclean-capital/neura/issues/8)) ([b59f79e](https://github.com/mclean-capital/neura/commit/b59f79e9ff57565ede7fc5abc44417e2fdb91aad))

# [1.6.0](https://github.com/mclean-capital/neura/compare/v1.5.0...v1.6.0) (2026-04-09)

### Features

- **core,types:** add transcript_chunks table for full-context deep search ([#6](https://github.com/mclean-capital/neura/issues/6)) ([66619ff](https://github.com/mclean-capital/neura/commit/66619ffac71821505d9ed39eaf0522dcf96b7185))

# [1.5.0](https://github.com/mclean-capital/neura/compare/v1.4.0...v1.5.0) (2026-04-09)

### Features

- **core,types:** implement Phase 5b advanced memory system ([#5](https://github.com/mclean-capital/neura/issues/5)) ([a440a6f](https://github.com/mclean-capital/neura/commit/a440a6fece237c03d6762cff90588ff7ef09ac91))

# [1.4.0](https://github.com/mclean-capital/neura/compare/v1.3.2...v1.4.0) (2026-04-08)

### Features

- **core,utils,types:** implement Phase 5 discovery loop ([#4](https://github.com/mclean-capital/neura/issues/4)) ([362cb44](https://github.com/mclean-capital/neura/commit/362cb44c9ce0fecae66b0981ac396ef18f35e619))

## [1.3.2](https://github.com/mclean-capital/neura/compare/v1.3.1...v1.3.2) (2026-04-08)

### Bug Fixes

- **ci:** build core dependencies before bundling in core-build workflow ([3b03e04](https://github.com/mclean-capital/neura/commit/3b03e04c84057864f62acc890c2a62ec3b1b0d8c))

## [1.3.1](https://github.com/mclean-capital/neura/compare/v1.3.0...v1.3.1) (2026-04-08)

### Bug Fixes

- **ci:** use reusable workflows for release asset builds ([563e92c](https://github.com/mclean-capital/neura/commit/563e92c3f0d1f02c540f59a228c7c7fe7e492734))

# [1.3.0](https://github.com/mclean-capital/neura/compare/v1.2.0...v1.3.0) (2026-04-08)

### Features

- **cli:** add neura backup and neura restore commands ([9d3e958](https://github.com/mclean-capital/neura/commit/9d3e9584b787f708c608599c0d5529a6147af537))

# [1.2.0](https://github.com/mclean-capital/neura/compare/v1.1.0...v1.2.0) (2026-04-08)

### Features

- Phase 3b Presence & Wake + Phase 4 Storage Hardening ([#3](https://github.com/mclean-capital/neura/issues/3)) ([b0f02f0](https://github.com/mclean-capital/neura/commit/b0f02f07c0bfdb27f75f706f30c7013909b51ec5))

# [1.1.0](https://github.com/mclean-capital/neura/compare/v1.0.0...v1.1.0) (2026-04-04)

### Features

- **cli,core:** implement neura update, auto-update check, and core build CI ([167206d](https://github.com/mclean-capital/neura/commit/167206d3076842b907bf92b3e5edaf0564649626))

# 1.0.0 (2026-04-04)

### Bug Fixes

- **core:** prevent listener accumulation on port retry, add shutdown timeout ([7237466](https://github.com/mclean-capital/neura/commit/7237466b6e4b6d88c47a28ffbca20670f43f3645))
- **desktop:** add window drag region so app can be moved ([bea727c](https://github.com/mclean-capital/neura/commit/bea727c5ff00c85ac830dd894438af61117284c1))
- **desktop:** resolve EADDRINUSE, add error boundary, crash logging, encryption guard ([d105c98](https://github.com/mclean-capital/neura/commit/d105c98c1c863e6651535857ed290df4d5558601))
- **desktop:** window drag region, traffic light clearance, default size ([0c8d017](https://github.com/mclean-capital/neura/commit/0c8d01709de5c539381939af8f63b33e468b1f8b))
- replace better-sqlite3 with sql.js, add favicon, auto-find port ([4e760fc](https://github.com/mclean-capital/neura/commit/4e760fca106af8a93505745abd29a77cec469c28))

### Features

- **cli:** add neura CLI for persistent core service management ([25d08e5](https://github.com/mclean-capital/neura/commit/25d08e526cd218dadc66e5cda5e9e948bbbc28b8))
- complete Phase 2a — provider adapters, structured logging, SQLite store, CI/CD pipeline ([1e7b5c5](https://github.com/mclean-capital/neura/commit/1e7b5c5580a313c43cac81b0b61e2331857318b2))
- **core,types:** replace sql.js with PGlite, add memory schema and types ([2de673d](https://github.com/mclean-capital/neura/commit/2de673dfa736c69dc94af03c6e81c368514f4a89))
- **core:** add memory runtime — prompt builder, extractor, manager, tools ([bf071f8](https://github.com/mclean-capital/neura/commit/bf071f8c909c3322c8d078f17fb629b65e8968dd))
- **design-system:** extract shared components, hooks, and Storybook ([0074cce](https://github.com/mclean-capital/neura/commit/0074cce1b3467278aaceb13ec5be45abd71ba7c5))
- **desktop:** add Electron desktop client (Phase 2b) ([f274734](https://github.com/mclean-capital/neura/commit/f274734ea746ccaf6daf5a03325a03d0ab7aed5e))
- extract hybrid prototype into packages (Phase 2a) ([5615ed0](https://github.com/mclean-capital/neura/commit/5615ed05d7944e89e546d05c25052da9c58c6e3d))
