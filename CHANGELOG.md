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
