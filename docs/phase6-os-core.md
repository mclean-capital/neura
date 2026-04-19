# Phase 6 — Neura OS Core

> **⚠️ PARTIALLY SUPERSEDED by Phase 6b** (see [`phase6b-task-driven-execution.md`](phase6b-task-driven-execution.md)).
>
> Phase 6b reclassifies skills as reference documentation (agentskills.io spec) rather than capability gates, moves worker dispatch to a task-ID-based model, and removes `run_skill`, `create_skill`, `import_skill`, and `allowed-tools` runtime enforcement. The sections of this doc describing those mechanisms are historical context, not current design. Worker runtime fundamentals (pi-coding-agent session lifecycle, clarification bridge, pause/resume, crash recovery) remain valid and unaffected.

Skill Framework + Agent Runtime + Clarification Loop + User-Initiated Pause/Resume.

**Status:** APPROVED (v2.3 + in-flight scope refinements, ready for implementation)
**Branch:** `feat/phase6-os-core`
**Repo:** `mclean-capital/neura`
**Mode:** Builder (open source)
**Originally drafted:** 2026-04-10 via `/office-hours` skill
**Moved into repo:** 2026-04-11 (from `~/.gstack/projects/mclean-capital-neura/` — this file is now canonical)
**Primary runtime:** `@mariozechner/pi-coding-agent` SDK (Approach D)
**Validated fallback runtime:** Claude Code CLI wrapper (Approach A)

## Revision history

- **v1** — Initial draft with Approach A (Claude Code subprocess wrapper)
- **v1.1** — Round 1 spec review fixes: Phase 5a hallucination, permissions model, wire format, effort estimate
- **v1.2** — Round 2 spec review fixes: store path consolidation, heartbeat definition, `run_skill` async, worker concurrency
- **v1.3** — Round 3 spec review APPROVED (9/10)
- **v2** — Approach D: pi-coding-agent SDK replaces Claude Code subprocess wrapper. Spikes #1, #2, #4 all passed. Spike #3 (SCION) showed SCION is not Phase 6 ready.
- **2026-04-11 (path)** — Moved from `~/.gstack/projects/` into the repo at `docs/phase6-os-core.md`.
- **v2.1 (2026-04-11)** — Codex cold read of v2 returned REVISE verdict (6/10). Two additional spikes ran (#4c pause+resume+beforeToolCall, #4d Neura skill path loading). Both PASSED. Major changes:
  - **Permissions model:** dropped `neura_tools_used` (the fork) in favor of the standard Agent Skills `allowed-tools` field enforced via pi's `beforeToolCall` hook. Spike #4c verified enforcement end-to-end. Neura-specific fields moved under the spec's `metadata:` object.
  - **Pause/resume corrected:** v2 described a "held run waiting for steer-resume" model that does not exist in pi. Spike #4c revealed the correct model: pause is a steer → agent_end → session becomes idle → conversation preserved → resume is a fresh `session.prompt()`, not a steer. Rewrote the section to match the real behavior.
  - **Skill loader sizing:** pi's `Skill` type does not surface `allowed-tools` or `metadata.*` — Spike #4d confirmed. Neura's loader needs to re-parse SKILL.md files to extract custom fields. ~130 lines instead of 30. Not a blocker.
  - **Session persistence:** switched recommended `SessionManager.inMemory()` to file-backed `SessionManager.create(cwd, sessionDir)` so pause survives a core restart.
  - **Listener performance:** added an async fanout design for voice-bridge subscribers to avoid the serial-await stall Codex flagged.
  - **Mechanical cleanup:** swept out stale Approach A / MCP / subprocess references that survived the v2 rewrite. Corrected Neura tool names (`describe_screen`, `create_task`, `get_current_time`).
- **v2.2 (2026-04-11)** — Codex round 2 cold read of v2.1 returned REVISE verdict (7/10). One spike ran (#4e restart-safe session resume). PASSED in 22s. Changes:
  - **[HIGH] Restart-safe resume — correct API.** v2.1 claimed `SessionManager.create(cwd, sessionDir)` could "reopen" sessions; it cannot — `create()` always starts a new session file. The reopen API is `SessionManager.open(sessionFile)` (pi's session-manager.d.ts:303). Spike #4e verified: file-backed session, `session.sessionFile` captured, `session.dispose()`, then `SessionManager.open(sessionFile)` + `createAgentSession({ sessionManager })` produces a new session object with the same `sessionId`, full history intact, and the agent continues the task on a fresh `prompt()`. **Workers table now stores `session_file` (filesystem path), not just `session_id`.** Resume flow rewritten.
  - **[MEDIUM] VoiceFanoutBridge coalescing fix.** The v2.1 sketch had two real bugs Codex caught: (a) the 250ms coalesce loop set `cutoff = Date.now() + 250` inside the while loop but never yielded the event loop, so the loop drained only deltas that were already queued at entry — it never actually waited for future deltas, which means the window was always near-zero. (b) `void this.drain()` created unhandled rejections on any drain error. Rewrote to use a real setTimeout-backed window and a `.catch()` on the fire-and-forget.
  - **[MEDIUM] Skill-path priority reversed in sketch.** Text in P4 says `./.neura/skills/` is highest priority, then `~/.neura/skills/`, then explicit config paths. The v2.1 implementation sketch listed them in the opposite order inside `loadSkills({ skillPaths })`. Fixed to match P4: repo-local first, then global, then explicit.
  - **[MEDIUM] `idle_partial` added to workers table status enum.** v2.1 listed it in the `WorkerStatus` type but the workers table schema in `worker-queries.ts` was missing it. Added.
  - **[LOW] P1 and P7 cleanup.** P1 still said "namespaced frontmatter fields (`neura_*`)" as if Neura had top-level `neura_*` fields; corrected to "under the `metadata:` nested field." P7 said "skills have a `neura_source` field"; corrected to "skills have `metadata.neura_source`."
  - **[LOW] Skill loader line count reconciled.** v2.1 had "~50 lines" in one place and "~130 lines" in another. Re-parse + diagnostic surfacing + NeuraSkill adapter lands at ~130 lines. Standardized.
- **v2.3 (current, 2026-04-11)** — Codex round 3 cold read of v2.2 returned REVISE verdict (6/10, down from 7/10 — surfaced issues I thought v2.1/v2.2 had cleaned up). Two HIGH, three MEDIUM, two LOW. All fixed via the scope-back-and-fix-all path (no new spikes). Changes:
  - **[HIGH] Worker lifecycle state machine was self-contradictory across three sections.** The startup recovery sweep, the crash→resume bullet, and the store layer section each said different things about what happens when the core restarts and finds a `running` or `blocked_clarifying` row. Codex caught three statements that could not all be true. **Resolution: scoped back.** Mid-run crash recovery is now explicitly **out of scope** for Phase 6. The startup sweep marks `running` / `blocked_clarifying` / `spawning` rows terminal-`crashed`. Only `idle_partial` rows (which were paused cleanly before the crash) are resumable. Spike #4e validated exactly this path, nothing more. Rewrote three sections to agree: "Worker crash recovery" startup sweep, "Resume semantics" bullet list, success criteria item 7. Added "The state machine in one sentence" summary. Phase 7 can scope in real mid-run recovery if pi ever supports mid-turn resume or Neura adds a transcript-repair layer.
  - **[HIGH] Subprocess vs in-process runtime contradictions in live text.** v2.1 claimed to have swept these, and v2.2 didn't catch the stragglers. Codex found: Constraints line ("plain Node subprocesses via `child_process.spawn`"), P5 ("Phase 6 ships with plain subprocess workers"), and Success Criteria item 7 ("kill a worker subprocess mid-run"). All three were still live text implying Approach A even though the implementation sections use Approach D in-process pi SDK. Fixed all three to match the in-process model. Added "In Approach D, 'runtime' means a new AgentSession instance, not a new process" aside to P3.
  - **[MEDIUM] Pause/resume correction didn't propagate into Next Steps step 13.** The normative section correctly described "pause = steer, resume = fresh prompt on idle session (no steer)," but the plan at step 13 still instructed `streamingBehavior: "steer"` for both. Fixed step 13 to match — pause uses steer, resume does NOT. Added an explicit reference to the Spike #4c pattern.
  - **[MEDIUM] VoiceFanoutBridge semantics were wrong even after the sleep fix.** Two real issues: (a) tool-call JSON artifacts from Grok's assistant text stream (observed in Spike #4) were being forwarded verbatim to voice — Neura would read `{"docName":"doc-alpha.pdf"}` out loud. (b) `agent_end` always triggered a `"Done."` interject regardless of `stopReason`, so the user would hear "Done." on every pause and every cancellation. Fix: added `stripToolCallArtifacts()` regex filter at push time, and made the `agent_end` affordance `stopReason`-aware (speak "Done." only on `stop`, stay silent on `aborted` / `error` / anything else).
  - **[MEDIUM] Portability overclaim on `allowed-tools`-less skills.** The design said "any skill written anywhere runs in Neura" while simultaneously applying a Neura-specific minimal-default-tools policy to skills that omit `allowed-tools`. Codex correctly pointed out that third-party skills relying on Claude Code's inherit-everything behavior would silently degrade under Neura. Fix: added an explicit "`allowed-tools` absence policy (Neura-specific)" section that names the divergence, explains the safety tradeoff (long-running ambient workers are higher-risk than interactive CLI sessions, silent unrestricted tool grants are unsafe), and tightens the portability claim to "any skill that DECLARES `allowed-tools` explicitly will run identically across runtimes."
  - **[LOW] Clarification tool always reset status to `running` on caught error.** Cancellation path leaked back into `running` instead of `cancelled`. Fix: check `signal?.aborted` and route to `cancelled` or `failed` with a structured error reason.
  - **[LOW] Stale references.** `NeuraSkillFrontmatter` type in Next Steps step 1 (no such type, there are no Neura-invented top-level frontmatter fields), `worker_store.last_used_at` terminology from earlier revisions. Both corrected.

**What Codex said is the "one thing the author is still too attached to":**

> "the 'single seamless voice magic trick.' It is forcing a lot of brittle machinery: `interject()`, half-duplex edge cases, inline hot-load timing, background narration, and zero-turn-break promotion. The design would get materially safer if you allowed one explicit turn boundary in more places instead of treating it as a product failure."

**Noted but not yet acted on** — this is a real product-shape question rather than a correctness bug. The demo script and the P6 ship criterion both depend on the "single unbroken take" cut. A future revision may trade off some seamlessness for reliability, but it's a deliberate product decision, not an oversight. Flagging it here so the implementation team knows it's on the table if any of the seamless primitives (`interject()`, zero-turn-break hot-load) turn out to be flaky in practice.

**Round 4 follow-up (2026-04-11):** Codex re-read v2.3 and returned REVISE 8/10 (up from 6/10) with three remaining issues. All fixed in place without bumping the version:

- **`stopReason` → `WorkerStatus` mapping was ambiguous across three sections.** One section said `stopReason: "aborted"` meant `failed`; another said `cancelled`; a third said "aborted" covered pause acknowledgment too. Fix: added an authoritative mapping table in "Worker crash recovery" under "Mid-task failure detection." `"stop"` is natural completion (including pause acknowledgment turns, distinguished via a `pendingPause` flag); `"aborted"` is exclusively the imperative-cancel path → `cancelled`; `"error"` → `failed`. Updated VoiceFanoutBridge to take a `pendingPause` flag set by agent-worker when sending a pause steer, so the bridge stays silent on the pause ack instead of saying "Done."
- **Top-level product claim "skill written anywhere runs in Neura" contradicted the later `allowed-tools` absence policy.** Codex correctly noted the narrowed claim at the permissions section didn't propagate to the What Makes This Cool pitch. Fix: tightened the top-level claim to "any skill that explicitly declares its `allowed-tools` runs identically across runtimes," with an explicit parenthetical pointing at the absence policy.
- **Stale leftovers.** "Worker IPC is filesystem + JSON-over-pipes for now" in Constraints (subprocess-era language — rewrote for in-process reality). "Claude Code CLI installation documentation" in CI/CD notes (no longer needed since pi is a library — rewrote to reference the bundle pipeline).

## Problem Statement

Neura has shipped through Phase 5b: voice (Grok), vision watcher (Gemini), presence + wake word, persistent memory with hybrid retrieval, Discovery Loop MVP, CLI client, security hardening. The next phase in the roadmap is Phase 6 — Skill Framework & Self-Extension. But the roadmap was written before the landscape shifted.

The shift: **Anthropic Agent Skills became a publicly adopted convention in early 2026** — SKILL.md files with YAML frontmatter, used by Claude Code natively, with an open spec in the `anthropics/skills` repository. Self-extending agent frameworks (Hermes Agent from NousResearch, OpenSpace from HKUDS) now ship closed learning loops as table stakes. And Google open-sourced SCION (container-based multi-agent orchestration) in April 2026.

The problem is no longer _"how do we standardize Neura's tools into skills"_ — that's a solved format. The problem is: **given that format is standardized and self-extension is commoditized, what does Neura actually build that's differentiated, and how does Phase 6 lay the first brick for Neura's longer-term vision as an operating system for autonomous work?**

The answer crystallized during this session: Phase 6 is not "skill framework" anymore. It's **Neura OS Core** — the kernel bring-up that ships a skill registry, a single agnostic agent-worker runtime, a clarification protocol between worker and user mediated by voice, and an inline promotion path that turns in-the-moment user clarifications into durable skills within the same voice session. Phase 6 and Phase 8 are fused because the skill format and the worker runtime define each other's interfaces — separating them was a roadmap artifact, not a real boundary.

## What Makes This Cool

Four differentiators, none individually novel, but **the combination is uncontested in April 2026**:

1. **Voice-first.** The conversation is the IDE. Skill creation happens mid-sentence, not in a file editor. "Hey Neura, make me a skill that..." is the natural input modality for describing capabilities. Hermes, Goose, MCP, and Claude Code are all CLI/IDE-first.

2. **Ambient / always-on.** Neura is present when you're working. Workers can run long-lived tasks and surface progress via ambient voice without you having to check a dashboard. Nobody else in the skill-framework space has this — they wait to be invoked.

3. **Agent Skills compatible.** Every skill Neura creates works in Claude Code, Cursor, Codex, and any future Agent Skills consumer. Skills are portable — any skill that explicitly declares its `allowed-tools` runs identically across runtimes. This is the opposite of lock-in, it's network effect. (The one asterisk: skills that omit `allowed-tools` hit runtime-specific defaults — see the "`allowed-tools` absence policy" later in the doc. Skill authors who care about portability should always declare the field explicitly.)

4. **Proactive AND reactive.** Most self-extending systems learn post-hoc from completed tasks (Hermes, OpenSpace). Neura learns from **mid-task clarification gaps** — the moment a worker doesn't know how to do something, it asks the user, the user answers, and the clarification is immediately promoted into a durable skill via a synchronous dispatch to another agent-worker with a write-skill task. **Gaps are a richer training signal than successes.** No competitor does this.

The **"oh damn" demo moment**: a single unbroken screen recording where the user asks Neura to do something requiring a capability it doesn't have, Neura's worker hits the gap mid-execution, asks the user for clarification, finishes the original task with the clarification, and then creates a new skill from the exchange on the spot — all visible in one take. The system is measurably more capable at the end of the video than the beginning. That's the demo. If we can't record that cleanly, Phase 6 isn't done.

## Constraints

- **Monorepo, TypeScript, Node >= 22.** No new language runtimes. New files land in `packages/core/` and `packages/types/`.
- **No new databases.** All persistence goes through the existing PGlite store. New tables are added via the existing migration system at `packages/core/src/stores/migrations.ts`.
- **Agent Skills format is non-negotiable.** Do not fork, do not extend in incompatible ways. Use only spec-compliant top-level fields (`name`, `description`, `version`, `allowed-tools`, `disable-model-invocation`). Put any Neura-specific metadata under the spec's `metadata:` nested field. **v2.1 has zero Neura-invented top-level frontmatter fields** — the earlier `neura_tools_used` and `neura_status` fields were dropped in favor of the spec's `allowed-tools` and `disable-model-invocation`.
- **Voice UX lives inside Grok's session.** Any mid-conversation interruption (progress updates, clarification requests from workers) must coexist with Grok's turn-taking and not break the half-duplex mic suppression that ships in `packages/cli/src/commands/listen.ts`.
- **Phase 6 must not break any existing test.** The current 270+ unit tests must continue to pass. New code ships with new tests (target ~80% coverage on new modules).
- **Long-lived workers, ambient progress.** Workers can run minutes or hours. Progress surfaces via voice in both active and passive presence modes. This integrates with the existing `PresenceManager`, not duplicates it.
- **No Docker, no SCION, no container runtimes** in Phase 6. Workers run **in-process** inside Neura core via the pi-coding-agent SDK (Approach D). SCION integration is Phase 8.
- **No external worker binary dependency for Phase 6.** Approach D embeds `@mariozechner/pi-coding-agent` as a library; there is no subprocess and no Claude Code CLI requirement. The `WorkerRuntime` interface is retained as a clean abstraction boundary so Approach A (Claude Code subprocess wrapper) can be dropped in as a validated fallback if pi-runtime ever becomes untenable.
- **Skill execution has a permissions model.** Skills declare required tools in the standard `allowed-tools` frontmatter field. Neura's `pi-runtime.ts` installs a `beforeToolCall` hook on `session.agent` that enforces the allowlist at invocation time. Draft skills (`disable-model-invocation: true`) do not execute autonomously. See "Permissions & Trust Tiers" below.
- **Design must not foreclose multi-user / cloud deployment** (Phase 9). Workers currently run in-process via pi-coding-agent and communicate with Neura through direct function calls and event subscriptions (no IPC boundary). When Phase 9 needs process isolation or multi-tenancy, the `WorkerRuntime` interface is the abstraction seam — a remote runtime can swap in without touching the orchestrator.

## New Dependencies (Approach D)

All runtime dependencies listed in one place so bundle + license review happens once:

| Package                         | Purpose                                                                                                   | License | Size    | Bundling note                                                                                                |
| ------------------------------- | --------------------------------------------------------------------------------------------------------- | ------- | ------- | ------------------------------------------------------------------------------------------------------------ |
| `@mariozechner/pi-coding-agent` | Full agent runtime, skill loader, tool surface, session management, event streaming, provider abstraction | MIT     | 10.5 MB | Verify bundleability with `scripts/bundle.ts` during implementation — pi uses ESM and should esbuild cleanly |
| `chokidar`                      | Watch skill directories for hot-reload (Neura-managed, not pi-managed)                                    | MIT     | small   | esbuild-safe                                                                                                 |

**Transitive deps worth noting:**

- `@mariozechner/pi-ai` — pulled by pi-coding-agent, provides 20+ LLM provider adapters including xAI (Neura already uses xAI for voice — shared key)
- `@mariozechner/pi-agent-core` — pulled by pi-coding-agent, the core agent loop (1859 lines, one dep — forkable in a weekend if upstream ever dies)
- `@sinclair/typebox` — pulled by pi-agent-core, used for tool parameter schemas (`Type.Object({...})`)

**Deleted dependencies from v1:**

- ~~`@modelcontextprotocol/sdk`~~ — no MCP server needed; Neura's custom tools plug directly into pi as `AgentTool` objects
- ~~`gray-matter`~~ — pi handles frontmatter parsing internally

**Deleted external binary dependency from v1:**

- ~~Claude Code CLI~~ — no longer required for Approach D. The Claude Code CLI dependency was only for Approach A (the fallback). If we ever switch back to Approach A, we'd need to reinstate the `claude` binary prereq in the install docs.

**Claude Code CLI as a user-optional tool:** Neura's skills, being Agent Skills compliant, still work in Claude Code. Users who already have Claude Code installed can invoke Neura-created skills there. But Neura no longer REQUIRES Claude Code to function.

## Premises

Each premise was explicitly confirmed by the builder during the session. They are load-bearing — if any is wrong, the design changes substantially.

**P1. Adopt Anthropic Agent Skills format verbatim.** The format is defined in the [anthropics/skills GitHub repository](https://github.com/anthropics/skills) and described in [Anthropic's engineering blog post](https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills). SKILL.md with YAML frontmatter (`name`, `description` required; spec-compliant `allowed-tools`, `disable-model-invocation`, `version`, `metadata` optional) + Markdown body + optional `scripts/` and `references/` subdirectories. **Neura adds zero top-level frontmatter fields.** All Neura-specific metadata (origin tracking, timestamps, source hints) goes under the spec's `metadata:` nested field as keys like `metadata.neura_source`. A skill authored for Neura validates against the stock Agent Skills schema.

**P2. Phase 6 MVP MUST include live self-creation, not just a loader.** A skill loader without the creation loop is a "me too" of Claude Code skills. The differentiator IS the live creation conversation. If Phase 6 can't ship that, it shouldn't ship yet.

**P3 (v2). Single agnostic `agent-worker` runtime. No specialized writer/runner split.** The worker takes a task. The task might be "execute skill X" or "write a new skill matching spec Y." Same runtime, different prompt and tool surface. Specialization lives in prompts and task context, not in worker types. This is the Unix instinct applied to agent architecture. (In Approach D, "runtime" means a new `AgentSession` instance — not a new process.)

**P4 (v2). Three-location skill storage with priority order.** Skills load from (1) `./.neura/skills/` repo-local overlay — highest priority, committable, team-shared; (2) `~/.neura/skills/` global cache — personal and installed; (3) explicit paths registered via config. All three use Agent Skills format. Resolution rule: **an entire skill directory shadows lower-priority locations by skill `name`. No merging of frontmatter or body.**

**P5. Defer SCION to Phase 8.** SCION is experimental and unsupported by Google. Phase 6 ships with **in-process pi-coding-agent workers** (Approach D). The design is SCION-compatible (skills are portable files, the `WorkerRuntime` interface abstracts over in-process SDK vs future subprocess/container runtimes) but does not integrate SCION yet.

**P6. Phase 6 ship criterion is a single unbroken screen recording.** Voice in → capability gap detected → clarification → skill creation → validation → hot-load → skill execution → result via voice. If we can't cut the video in one take, the phase is not done.

**P7. Memory-driven proactive skill suggestions are NOT in Phase 6 MVP.** Phase 5b memory is the enabler, but the proactive suggestion layer ("Neura noticed you keep doing X — want a skill for it?") is Phase 7 territory. Phase 6 leaves schema hooks (skills carry a nested `metadata.neura_source` key to track origin) but does not ship the trigger loop.

**P8 (v2.1). Clarification-to-skill promotion happens INLINE, not via a deferred execution loop.** When an `agent-worker` hits a capability gap, it calls the pi custom tool `request_clarification` (in-process, not over MCP). The tool's `execute` handler blocks on the user's voice response via the existing transcript pipeline. When the user responds, the handler returns the answer as the tool result AND fires a fire-and-forget `void dispatchPromotionWorker(...)` that spawns a new pi AgentSession with a write-skill task template, capturing the exchange into a durable skill. The skill is ready within seconds, during the same voice session. **Phase 6 does NOT build a background execution loop** — that's Phase 7 work.

## Cross-Model Perspective

A Codex cold read (model: `gpt-5.4`, reasoning effort: high) was run after premise confirmation. Codex inspected `packages/core/src/tools/tool-router.ts`, `registry.ts`, and the existing tool files before responding, so its advice is grounded in the actual codebase structure.

**Codex steelman:** _"Neura becomes the first ambient developer assistant that can hear a missing capability in a live voice conversation, contract for it, synthesize an open-standard skill, hot-load it into the running session, and immediately use it. Not 'an assistant with plugins,' but a persistent voice runtime that can extend itself without breaking the conversation and without locking the skill to Neura."_

**Codex key insight:** The revealing line from the session was _"A static loader without self-creation is a 'me too' of Claude Code skills."_ Codex's reframe: **the product is not a skill framework. It is a live adaptation loop.** The MVP should optimize only for `need detected → clarify → write → validate → load → use`. Everything else is distraction.

**Codex challenged the original P4.** The original premise said "skills live in `~/.neura/skills/`." Codex argued this was wrong for fellow devs: _"A global home-dir skill folder is the wrong primary surface. It kills versioning, review, repo portability, and team sharing."_ Challenge accepted. P4 was revised to the three-location flexible storage model.

**Codex demo suggestion:** `red-test-triage` — using existing vision + task tools for a real dev workflow. **Adopted as the primary demo skill.**

**Codex bluntness:** _"If the first demo is just 'voice generated a markdown file,' devs will call it prompt theater and move on. The only thing that matters is whether the single-take video shows a new capability appearing mid-conversation and doing something a developer actually wants five minutes later."_ Ship criterion P6 is designed to meet this bar.

## Spec Review (round 1) — findings that shaped this revision

An independent reviewer with fresh context reviewed the first draft of this document. Key findings incorporated:

1. **[CRITICAL]** The first draft claimed a "Phase 5a execution loop" existed and picked up promotion work items during passive presence. This was wrong — the discovery loop creates work items but explicitly does NOT execute them. P8 has been revised to inline promotion (Option A). See P8 above.

2. **[CRITICAL]** The first draft had no permissions/sandbox model. Skills and workers could invoke arbitrary tools including bash/file-edit. A new "Permissions & Trust Tiers" section has been added below.

3. **[HIGH]** Wire format for worker↔orchestrator clarification used sentinel strings (`<<NEURA:CLARIFY>>...<<END:NEURA>>`) that could collide with Claude Code output. Replaced with MCP tool calls via the same MCP server that exposes Neura's tool surface — `request_clarification` is just another MCP tool the worker can call.

4. **[HIGH]** Effort estimate for Approach A said "1-2 weeks" but the task breakdown summed to ~4 weeks. Revised to M (3-4 weeks).

5. **[HIGH]** Claude Code programmatic invocation and Grok session.update behavior during active responses are both unverified assumptions that the entire design depends on. Both are now **mandatory blocking spikes** before any implementation begins, with explicit fallback paths.

6. **[HIGH]** Worker crash recovery was listed as an "open question" but is essential for a 2-minute demo task. Moved into the spec with a concrete recovery strategy.

7. **[HIGH]** Promotion worker prompt template was referenced but not defined. Added as a concrete section.

8. **[MEDIUM]** Demo script referenced on-screen progress indicators but the architecture is voice-only. Removed references to on-screen UI elements.

9. **[MEDIUM]** `import_skill` tool scope creep — could pull in URL fetch, git clone, signature verification. Restricted to local filesystem paths only for Phase 6.

10. **[MEDIUM]** MCP server was added without justifying vs simpler alternatives. Justification added below.

11. **[LOW]** File paths used a `queries/` subdirectory that doesn't match the existing flat layout under `packages/core/src/stores/`. Corrected.

12. **[LOW]** `neura_source` was speced as a closed enum; Phase 7 will want more values. Changed to open non-empty string.

## Permissions & Trust Tiers

Skills are code-adjacent artifacts. Phase 6 ships a minimal but explicit trust model.

### Trust tiers via `disable-model-invocation` (pi's native field)

Pi's skill loader supports a `disable-model-invocation: true` frontmatter field natively. Skills marked with this are loaded into the registry but are NOT included in the Grok system prompt catalog and cannot be auto-triggered by the model. They can only be invoked explicitly via `/skill:name` (interactive) or a direct `run_skill` tool call with a fully-qualified name.

**Neura's draft/ready distinction maps to this:**

- **Draft** — `disable-model-invocation: true` in frontmatter. Skill is in the registry, visible via `list_skills`, but not in the Grok prompt and not auto-invokable. Created this way by the promotion worker when capturing clarifications (so the user can review before activating).
- **Ready** — `disable-model-invocation: false` or absent. Skill is in the Grok prompt catalog, auto-invokable by the model when the description matches, and callable via `run_skill`. Created this way by direct `create_skill` invocation when the user explicitly confirms the skill during the conversation.

**Invariant:** draft skills (`disable-model-invocation: true`) are loaded by the registry, shown in `list_skills`, excluded from the Grok system prompt context via pi's `formatSkillsForPrompt` filter. They exist for introspection, not autonomous execution. The user promotes them to ready via the `promote_skill` tool, which clears the flag and re-renders the prompt context.

**Why adopt pi's field instead of a Neura-specific `neura_status`:** pi already parses and respects it. Writing our own enum means adding a parallel mechanism that does the same thing. One source of truth is better. Spike #4 source review confirmed pi's `formatSkillsForPrompt()` already excludes `disable-model-invocation: true` skills — zero extra code.

### Tool allowlist via the standard `allowed-tools` field

**[v2.1 CORRECTION]** v2 of this doc used a Neura-specific `neura_tools_used` frontmatter field. Codex correctly flagged that this was a fork of the Agent Skills standard — it contradicted the "skills written anywhere run in Neura" portability claim. v2.1 drops `neura_tools_used` in favor of the standard `allowed-tools` field that already exists in the Agent Skills spec and is documented by pi (currently as "experimental" because pi does not yet enforce it).

Every skill declares the Neura custom tools it's authorized to call via the standard `allowed-tools` frontmatter field — a space-delimited list per the Agent Skills spec:

```yaml
allowed-tools: create_task recall_memory get_current_time
```

**Why this preserves portability:**

- The field is in the Agent Skills spec. Claude Code, Cursor, Codex, and pi all read it (Claude Code and Cursor currently treat it as documentation; pi reads the frontmatter but does not enforce; Neura will be the first runtime to implement enforcement).
- A skill authored in Claude Code with `allowed-tools: edit bash` just works in Neura — Neura sees the field, enforces it in its own tool context. If the skill references tools Neura doesn't know (`edit`, `bash`), Neura logs a diagnostic naming the missing tools and the skill falls back to the equivalent Neura tools when possible, otherwise the skill runs with the tools it asked for that Neura actually has.
- A skill authored in Neura with `allowed-tools: create_task recall_memory` works anywhere else too — other runtimes that don't know these tool names will silently ignore what's not in their registry.
- There is no fork. The field is the spec.

**What workers can and cannot do (orchestrator/worker split):** Workers do NOT have vision. `describe_screen` and `describe_camera` are orchestrator tools — Grok calls them during the voice session when the user asks to look at something on screen, and any visual context a worker needs to do its job is captured by Grok and passed into the worker's task description as text. This keeps workers stateless with respect to the user's physical environment (no per-client watcher delegate to thread through the runtime, no question about which client's camera feed the worker sees when the user reconnects mid-task) and gives the orchestrator full control over when the camera/screen watcher actually fires. If a future use case genuinely needs workers to drive vision queries, it will come back as a Phase 8+ design discussion; there's no plan to thread vision through workers in Phase 6 or 7.

**One honest caveat about portability:** skills **without** an `allowed-tools` field are a Neura-specific edge case. The Agent Skills spec says `allowed-tools` is optional. In Claude Code, a skill without the field gets access to whatever tool set the session was launched with. Neura does NOT do that — see the "allowed-tools absence policy" below. A skill that omits `allowed-tools` will execute differently in Neura than in Claude Code. The portability claim is: **any skill that DECLARES `allowed-tools` explicitly will run identically across runtimes.** Skills that don't declare the field are implementation-dependent across runtimes, the same way any optional field is.

**Enforcement mechanism:** Neura's `pi-runtime.ts` sets `session.agent.beforeToolCall` to a function that:

1. Parses the current skill's `allowed-tools` frontmatter field at skill-load time and caches the allowlist on the `NeuraSkill` object.
2. On every tool call attempt, resolves the currently-executing skill (from the task spec set at dispatch time).
3. If the tool call's name is NOT in the skill's `allowed-tools` list, return `{ block: true, reason: "Tool '<name>' is not in this skill's allowed-tools list." }`
4. Otherwise return `undefined` (allow).

**Verified end-to-end by Spike #4c** — see `tools/spikes/phase6/pi-test/spike4c-resume.mjs`:

- Tool `secret_delete` was not in the allowlist
- `beforeToolCall` invoked 5 times during the session, blocked `secret_delete` 1 time
- The block surfaced as `tool_execution_end isError=true`
- The agent's final message said in plain English: _"The secret_delete call failed with the message 'Tool secret_delete is not in this skill's allowed-tools list.' All uploads succeeded, and allowed_list reported 3 files uploaded."_
- The `secret_delete` execute function was never called (execution counter stayed at 0)

The voice bridge can surface the block as an ambient notification or pass it through to the user depending on severity. For Phase 6, ambient notification is enough — the agent observes the block and gracefully completes the task.

**Out of scope for Phase 6:** bash/shell command sandboxing. Pi's bash tool executes real shell commands. If a skill or task template instructs the worker to run `rm -rf /`, it will try. This is an accepted risk for Phase 6 dogfooding (solo user, local machine), documented in the README, and scoped for hardening in Phase 8 with SCION container isolation.

### Neura-specific metadata lives under the spec's `metadata:` field

The Agent Skills spec defines a `metadata` top-level frontmatter field for "arbitrary key-value mapping" (per pi's skills.md reference). Any Neura-specific metadata (origin tracking, creation timestamps, etc) goes there as nested keys. This keeps the top-level frontmatter standard-compliant and prevents field-name collisions with other runtimes.

```yaml
metadata:
  neura_source: clarification_capture
  neura_created_at: 2026-04-11T00:12:34Z
  neura_created_by: agent-worker
```

Neura's loader reads these by re-parsing the SKILL.md frontmatter after `loadSkills()` returns (since pi's `Skill` type doesn't surface custom fields — confirmed by Spike #4d). See the "Skill loader" section under Files to create for the scope impact.

### Skill-authoring tasks bypass the `allowed-tools` allowlist

The `allowed-tools` enforcement applies to workers **executing a skill** — `beforeToolCall` resolves the current skill context and rejects tool calls not in its declared list. This does NOT apply to workers **authoring skills** (the promotion worker, direct `create_skill` invocations). Skill-authoring workers need pi's built-in `write`, `edit`, `read` tools (which are pi's native tools, not Neura custom tools) to actually write the SKILL.md file. They may also need Neura tools like `recall_memory` or `list_skills` to decide whether to update an existing skill or create a new one.

**Enforcement rule:** the `beforeToolCall` hook checks the task spec at dispatch time. Task specs with `taskType: "promote_clarification"` or `taskType: "write_skill"` run in an "authoring" context and the hook allows all tool calls. Task specs with `taskType: "run_skill"` or `taskType: "execute_skill_implicit"` run in an "execution" context and the hook applies the `allowed-tools` allowlist. The context is set by `pi-runtime.ts` when creating the session, not inferred.

This is the minimum permissions distinction required to make the inline promotion path work. Phase 8's SCION hardening will add a capability layer on top of this (e.g. authoring workers cannot touch anything outside `~/.neura/skills/` or `./.neura/skills/`, even with pi's file_write tool).

## Approaches Considered

### Approach D — pi-coding-agent SDK (RECOMMENDED, SELECTED)

**Summary:** Neura embeds `@mariozechner/pi-coding-agent` as a Node library via its SDK (`createAgentSession`). pi provides the agent loop, skill loading (Agent Skills standard compliant), built-in tools (bash, read, write, edit, grep, find, ls), session management, compaction, auth storage, and a multi-provider LLM abstraction via `pi-ai`. Neura registers its custom tools (vision, memory, task, presence, time) via the `customTools` option, subscribes to the event stream for voice progress routing, and uses `session.prompt(..., { streamingBehavior: "steer" })` for user-initiated pause/resume.

**Effort:** **M (2-3 weeks focused work, including demo polish)** — smaller than Approach A because pi provides ~40% of what Neura would otherwise build (skill subsystem, tool surface, session management, message compaction, auth storage).

**Risk:** Low-Medium (validated by Spike #4 — both SDK embedding and steer-mid-execution tests passed; single-author dependency risk is the main concern).

**Pros:**

- Spike #4 **PASSED**: SDK embedding worked in 2.7 seconds end-to-end (vs 10.2 seconds for Approach A equivalent in Spike #1 — 4x faster)
- Spike #4b **PASSED**: `session.prompt(..., { streamingBehavior: "steer" })` interrupts a running agent at the next tool-call boundary. User-initiated pause is one line of code. No Option C checkpoint dance needed.
- Pi implements the **Agent Skills standard verbatim** (same format as Claude Code, Cursor, Codex) — P1 is preserved
- Pi's `loadSkills()`, `formatSkillsForPrompt()`, name validation, collision handling, `.gitignore` support, symlink dedup — **508 lines of skill infrastructure we don't have to write**
- Pi's `beforeToolCall` / `afterToolCall` hooks are exactly the permissions enforcement point the design doc specifies — no custom MCP adapter middleware needed
- Pi's event stream (`agent_start`, `turn_start`, `message_update`, `tool_execution_start/end`, `turn_end`, `agent_end`) is structured JavaScript, no stream-json parsing
- Pi supports **20+ LLM providers** including xAI (Neura's existing voice provider) — single API key covers voice + worker
- Pi's message compaction is built in — long sessions don't blow the context window
- Pi's `CustomAgentMessages` declaration merging lets Neura add internal message types without forking
- Pi ships both SDK mode (in-process) and RPC mode (subprocess) — we can swap if stability issues emerge, same `WorkerRuntime` interface
- MIT licensed, pi-agent-core has **one** transitive dependency — forkable in a weekend if the upstream ever dies
- No Docker, no SCION, no container images, no separate CLI subprocess
- Ships the full clarification capture loop with simpler primitives than the MCP-tool-blocking approach

**Cons:**

- Single-author dependency (Mario Zechner, badlogic) vs Anthropic's Claude Code (company)
  - Mitigation: 245 releases over time, latest 2 days ago, active maintenance. pi-agent-core is 1859 lines across 5 files — small enough to fork and maintain ourselves if needed.
- In-process execution = worse crash isolation than subprocess mode
  - Mitigation: pi ships an RPC mode (`runRpcMode`) that provides subprocess isolation with the same `WorkerRuntime` interface. SDK mode is the default; RPC mode is the escape hatch.
- Pi's built-in tool set (7 tools) is narrower than Claude Code's (10+)
  - Mitigation: the gap is web search and git. Web search would be a Neura custom tool anyway (integrated with existing Gemini search). Git operations are bash calls. Real gap is small.
- Less battle-tested on adversarial real-world workloads than Claude Code
  - Mitigation: pi-coding-agent's stated purpose is being an "extensible alternative to Claude Code" — Mario dogfoods it daily for his own coding work. 3496 commits of iteration.

**Reuses:** pi's entire skill subsystem (`loadSkills`, `loadSkillsFromDir`, `formatSkillsForPrompt`, validation, collision handling), pi's built-in tools (bash/read/write/edit/grep/find/ls), pi's extension system, pi's session management, pi's message compaction, pi's auth storage, pi's model registry, pi-ai's multi-provider abstraction, Phase 5a Discovery Loop notification infrastructure, presence state machine, Grok voice session management.

**Credit:** [@mariozechner](https://github.com/badlogic) — Mario Zechner. Neura will credit him prominently in the Phase 6 release notes and README if we ship on pi.

### Approach A — Claude Code Wrapper (VALIDATED FALLBACK)

**Status:** Validated by Spikes #1 and #2 (both PASSED). Available as a fallback if Approach D hits an unforeseen issue in implementation. NOT the primary recommendation anymore as of v2 of this doc.

**Summary:** `agent-worker` is a thin subprocess wrapper around Claude Code CLI. Claude Code does the heavy lifting: tool surface, multi-turn reasoning, skill loading (native Agent Skills support). Neura is the voice-first coordinator on top.

**Effort:** **M (3-4 weeks focused work, including demo polish)** — kept at this estimate because it was accurate; Approach D is faster because pi provides more primitives natively.
**Risk:** Medium (both blocking spikes passed, so the risk is in ongoing Claude Code CLI stability and per-invocation API cost)

**Pros:**

- Inherits Claude Code's tool surface for free (bash, file edit, read, web search, grep)
- Agent Skills compatibility is automatic — Claude Code reads the format natively
- Demo is more impressive from day one because the worker can do real dev work
- Forward-compatible with Phase 8 SCION (SCION supports Claude Code as a harness)
- Zero maintenance of the agent loop — Anthropic maintains it

**Cons:**

- Hard dependency on Claude Code CLI stability and invocation API
- Per-worker cost = Claude API (not trivial for long tasks)
- Less control over interaction protocol (Claude Code dictates message format)
- Users without Anthropic API access can't run workers

**Reuses for Approach A (the validated fallback):** Existing tool router (the current Neura tools), work item system, presence state machine, Grok voice session management.

### Approach B — Native Gemini Loop (SUBSUMED by Approach D in v2.1)

**v2.1 status:** subsumed. pi-ai (pulled in by pi-coding-agent) already includes a Gemini adapter — `getModel("google", "gemini-2.0-flash-exp")` or similar — so "custom Gemini loop" is no longer a meaningful alternative to Approach D. If Approach D hits an unforeseen issue with its default model (Grok via xAI), the first fallback is to switch pi's model to Gemini via one line of config. No separate runtime needed.

**Historical summary:** v1/v2 framed Approach B as "build a custom agent loop using `@google/genai`." That's 3-4 weeks of work. In v2.1 it's unnecessary — pi abstracts over the provider and gives you Gemini for free.

### Approach C — Hybrid Router

**Summary:** Abstract `WorkerRuntime` interface with both Claude Code and Gemini implementations from day one.

**Effort:** L (5-6 weeks)
**Risk:** High (abstraction layers add complexity, risk shipping two half-working implementations)

Not recommended for Phase 6 — adds upfront cost without shipping value. The selected approach (A with a clean internal `WorkerRuntime` boundary) gets Approach C's optionality without the cost: a second runtime can be added in Phase 7 as a focused addition, not a parallel build.

## Recommended Approach

**Approach D (pi-coding-agent SDK) with an internal `WorkerRuntime` boundary.** All spikes have been run and the path is clear.

**Why Approach D over Approach A (the v1.3 recommendation):** Spike #4 demonstrated that pi-coding-agent gives Neura native pause/resume primitives, native mid-execution steering, native Agent Skills standard compliance, and a 4x faster end-to-end round-trip than the Claude Code subprocess approach. It also ships ~500 lines of skill infrastructure (`loadSkills`, validation, collision handling, XML prompt formatting, symlink dedup, gitignore support) that the design doc originally scoped for Neura to write. The cost is a single-author dependency (Mario Zechner, MIT-licensed pi-mono) that can be forked in a weekend if needed — pi-agent-core is 1859 lines across 5 files with one transitive dep.

**Why Approach D over SCION:** Spike #3 showed SCION requires container image builds, a container registry, and complex local setup that's disqualifying for Neura's "open source builder tool" DX positioning. SCION is a Phase 7+ candidate when it matures and ships public images; it's not Phase 6 viable today. pi-coding-agent ships via `npm install`.

**Approach A stays as a validated fallback.** Spikes #1 and #2 both passed cleanly, so if pi-coding-agent hits an unforeseen blocker during implementation, swapping back to the Claude Code subprocess wrapper is a focused refactor behind the `WorkerRuntime` interface — not a rewrite. The work from Spikes #1 and #2 isn't wasted.

### Completed Spikes (historical record)

All six spike scripts have been run. Full writeups in `tools/spikes/phase6/`:

- **Spike #1 — Claude Code programmatic invocation** (PASS, `FINDINGS.md`). Script 1: basic MCP echo round-trip in 10.2s. Script 2: 90-second blocking MCP handler in 101.3s. Validated that Approach A is feasible as a fallback.
- **Spike #2 — Grok session.update mid-session** (PASS, `FINDINGS.md`). Verified Grok accepts `session.update` between turns and applies new instructions on the next turn with ~90ms latency. Hot-loading skills works.
- **Spike #3 — SCION feasibility on macOS** (NOT READY, `SCION-FINDINGS.md`). SCION requires container image builds, a container registry, and significant setup. Not Phase 6 viable. Revisit in Phase 7+.
- **Spike #4 (4a + 4b) — pi-coding-agent SDK** (PASS, `PI-FINDINGS.md`). Script 4a: SDK embedding + custom tool + event streaming in 2.7s. Script 4b: `streamingBehavior: "steer"` mid-execution interrupts a running agent at the next tool-call boundary (agent called `fake_upload` 1 time out of 3 planned, acknowledged with "paused"). Approach D became the primary recommendation.
- **Spike #4c — pause + resume round-trip + beforeToolCall enforcement** (PASS, NEW in v2.1, writeup inline below). Validated (a) the correct pause/resume model: pause via steer → `agent_end` → idle → resume via fresh `session.prompt()` on the same session with preserved transcript; (b) `beforeToolCall` hook invoked 5 times during a session, blocked `secret_delete` 1 time, agent observed the block and continued gracefully. Session persisted through a 20-second idle period. Total elapsed: 42.1s.
- **Spike #4d — Neura skill path loading** (PASS, NEW in v2.1, writeup inline below). Verified pi's `loadSkills({ skillPaths, includeDefaults: false })` successfully loads skills from `./.neura/skills/` paths in 7ms. `disable-model-invocation` filter works — `formatSkillsForPrompt()` output excluded the draft skill. Found that pi's `Skill` type does not expose `allowed-tools` or `metadata.*` — Neura's loader must re-parse SKILL.md to extract them.
- **Spike #4e — restart-safe session resume** (PASS, NEW in v2.2, writeup at `spike4e-restart.mjs`). Verified pi's file-backed session can be fully disposed and reopened from disk via `SessionManager.open(sessionFile)` with conversation history intact. Ran a 3-upload task, paused after upload 1, called `session.dispose()`, reopened the same JSONL via `SessionManager.open()`, created a new `AgentSession` around the reopened manager, sent a resume prompt. Uploads 2 and 3 completed in the reopened session, no duplicate calls to upload 1, same `sessionId` across both session objects. Total elapsed: 22.1s. This validated the workers-table `session_file` column design and corrected the v2.1 doc's incorrect claim that `SessionManager.create()` was the reopen API.

### Historical: the two gating spikes that Approach A required (both passed)

**Spike #1 — Claude Code programmatic invocation** (1.5 days)

Verify all of:

- Claude Code supports non-interactive invocation with a structured task prompt (likely `claude -p "..."` or similar)
- Claude Code can connect to an MCP server over stdio to access external tools
- Claude Code's output stream is parseable (structured messages, not raw terminal escape codes)
- The invocation can be cancelled mid-run (SIGTERM behavior)
- **Long-blocking tool calls work.** The `request_clarification` pattern requires an MCP tool that may block for several minutes while a human listens to the voice question and responds. This is an unusual MCP usage (tool calls are typically millisecond RPC) and the MCP SDK + Claude Code client may have implicit timeouts.

**Pass criteria (two scripts):**

_Script 1 — basic MCP echo:_ A ~50-line script that spawns Claude Code with an MCP server exposing a single `echo` tool, sends a prompt like "call the echo tool with 'hello'", and receives a structured confirmation on stdout. Working end-to-end.

_Script 2 — long-blocking tool handler:_ A ~50-line script that spawns Claude Code with an MCP server exposing a `sleep_then_echo` tool whose handler awaits a `setTimeout(90_000)` before returning. Prompt: "call sleep_then_echo with 'hello'". The tool result must arrive successfully after ~90 seconds without MCP SDK timeout, Claude Code disconnect, or process crash. If the default timeout is lower, the server must be configurable to accept long handlers and the Claude Code client must respect that configuration.

**Fail criteria (historical — both tests passed, see FINDINGS.md):**

- Script 1 fails → at the time, this meant fall back to Approach B. In v2.1 there IS no Approach B to fall back to (subsumed by Approach D). The v2.1 fallback if pi-coding-agent fails is Approach A (Claude Code subprocess wrapper) — which these spikes already validated.
- Script 2 fails with a timeout that cannot be configured away → would have meant `request_clarification` cannot be a blocking MCP tool call. Moot for Approach D because pi's `request_clarification` runs in-process without an MCP boundary.

**Spike #2 — Grok session.update during active response** (0.5 day)

Verify that `session.update` with a modified system prompt can be sent to Grok's Realtime API mid-session without breaking the in-flight response, and that the new prompt takes effect on the next user turn without requiring a full session restart.

**Pass criteria:** Manual test shows Neura can inject a new "here is a new skill" block into the system prompt between turns, and Grok uses the new skill on the immediately following user utterance.

**Fail criteria:** Grok ignores the update until the next session, or crashes. → **Design change required:** skill creation must be followed by an explicit turn break ("Skill created. Try it now."), not a seamless continuation. This weakens the demo but keeps Approach A viable.

**These spikes were non-negotiable gates for v2 (Approach A).** All five spikes have since passed (#1, #2, #4, the v2.1 additions #4c and #4d, and the v2.2 addition #4e). No pending gates remain.

### High-level architecture (Approach D — pi-coding-agent)

```
┌─────────────────────────────────────────────────────────────────────┐
│  NEURA CORE (orchestrator / kernel)                                 │
│                                                                     │
│  Voice Session (Grok Realtime)  ◄────────►  User                    │
│       │                                                             │
│       │ tool call: create_skill / run_skill                         │
│       ▼                                                             │
│  Tool Router ──────────────┬────────────────┐                       │
│       │                    │                │                       │
│       │                    ▼                ▼                       │
│       │             pi loadSkills()   Work Item Store               │
│       │             (Agent Skills)    (PGlite)                      │
│       │             ./.neura/skills/   skill_usage table            │
│       │             ~/.neura/skills/   workers table                │
│       │             <explicit paths>                                │
│       │                                                             │
│       │ createAgentSession()                                        │
│       ▼                                                             │
│  ┌──────────────────────────────────────────┐                       │
│  │  pi-coding-agent AgentSession (in-proc)  │                       │
│  │                                           │                       │
│  │  WorkerRuntime → PiRuntime (default)     │                       │
│  │                  ClaudeCodeRuntime (alt) │                       │
│  │                                           │                       │
│  │  pi-agent-core Agent                     │                       │
│  │    │                                     │                       │
│  │    ├── Built-in tools (pi):              │                       │
│  │    │     bash, read, write, edit,        │                       │
│  │    │     grep, find, ls                  │                       │
│  │    │                                     │                       │
│  │    ├── customTools (Neura):              │                       │
│  │    │     vision.*, memory.*, task.*,     │                       │
│  │    │     presence.*, time.*,             │                       │
│  │    │     request_clarification,          │                       │
│  │    │     report_progress,                │                       │
│  │    │     create_skill (recursive)        │                       │
│  │    │                                     │                       │
│  │    ├── beforeToolCall hook:              │                       │
│  │    │     permissions enforcement         │                       │
│  │    │     (skill's allowed-tools          │                       │
│  │    │      frontmatter field)             │                       │
│  │    │                                     │                       │
│  │    └── pi-ai provider abstraction:       │                       │
│  │          xai/grok-4-fast, anthropic,     │                       │
│  │          openai, google, ...             │                       │
│  └──────────────────────────────────────────┘                       │
│       │                                                             │
│       │ AgentEvent stream via session.subscribe()                   │
│       │   (agent_start, turn_start, message_update,                 │
│       │    tool_execution_start/end, turn_end, agent_end)           │
│       ▼                                                             │
│  Clarification Bridge  → grokSession.interject()                    │
│       │                                                             │
│       │ inline promotion via synchronous                            │
│       │ createAgentSession + prompt(skill-writer template)          │
│       ▼                                                             │
│  Second pi AgentSession — writes draft SKILL.md                     │
└─────────────────────────────────────────────────────────────────────┘

User-initiated pause flow (new in v2 — replaces Option C checkpoint dance):

  User: "Pause the upload, I need to make a call"
       │
       ▼
  Grok transcribes → intent detection → Neura core
       │
       ▼
  session.prompt(
    "STOP. Wait for user to say continue.",
    { streamingBehavior: "steer" }
  )
       │
       ▼
  Pi Agent processes the steering message at the next tool-call
  boundary. Current tool finishes cleanly (no mid-upload corruption),
  agent does not start the next tool, says "paused", goes idle.
       │
       ▼
  User: "OK, continue"
       │
       ▼
  session.prompt(
    "OK, continue with the remaining work.",
    { streamingBehavior: "steer" }
  )
       │
       ▼
  Agent resumes, picks up where it left off, finishes the task.
```

### Files to create (Approach D)

**Skill system** (under `packages/core/src/skills/`) — **mostly delegates to pi-coding-agent with a thin Neura-specific wrapper**:

- `skill-loader.ts` (~130 lines, revised from v2) — wraps pi's `loadSkills({ skillPaths: ['./.neura/skills', '~/.neura/skills', ...explicitPaths], includeDefaults: false })` call. **Priority order matches P4: repo-local first (highest), then global, then explicit paths.** Pi walks `skillPaths` in order and an earlier-listed location shadows a later one by skill `name`. Verified by Spike #4d (7ms to load 2 fixture skills from `./.neura/skills/`). **Plus** a re-parse step: for each returned `Skill`, re-reads the SKILL.md file and extracts `allowed-tools` (space-delimited string) and `metadata.*` fields into an extended `NeuraSkill` type. This is necessary because pi's `Skill` type only exposes `name`, `description`, `filePath`, `baseDir`, `sourceInfo`, `disableModelInvocation` — custom fields are parsed by pi but not surfaced. Uses the same `parseFrontmatter` utility pi itself uses (re-exported from `@mariozechner/pi-coding-agent`).
- `skill-watcher.ts` (~100 lines) — `chokidar` watching the three skill locations, on change calls `loadSkills()` again and updates the in-memory registry. Hot-reload without restart. Verified path-loading works in Spike #4d; hot-reload behavior is new code for v2.1 (not yet spiked but is a pure chokidar+reload pattern with minimal risk).
- `skill-registry.ts` (~120 lines) — in-memory index of loaded skills keyed by name. Methods: `list()`, `get(name)`, `getPromptContext(budgetTokens)` (reuses pi's `formatSkillsForPrompt` with token budgeting wrapped on top), `notifyUsed(name)` (bumps skill_usage MRU), `getAllowedTools(skillName)` (returns the parsed allowed-tools list for the `beforeToolCall` enforcement hook).
- `neura-skill.ts` (~60 lines, NEW in v2.1) — defines the `NeuraSkill` type that extends pi's `Skill` with `allowedTools: string[]` (parsed from `allowed-tools` frontmatter) and `metadata: Record<string, unknown>` (parsed from the `metadata:` frontmatter object). Plus a small `toNeuraSkill(skill: pi.Skill): NeuraSkill` helper that does the re-parse. The ~130 line count on `skill-loader.ts` covers the wrapping + diagnostic surfacing; `neura-skill.ts` is a separate type-only module.
- `index.ts` — barrel export

**Still deleted from original design** (pi provides them):

- ~~`skill-parser.ts`~~ — pi handles Agent Skills spec parsing; Neura's loader re-parses only for custom field extraction
- ~~`skill-locations.ts`~~ — pi's `loadSkills({ skillPaths })` handles multi-location resolution (verified by Spike #4d)
- ~~`skill-validator.ts`~~ — pi validates name, description, length, character rules; Neura adds only a warning for unknown tool names in `allowed-tools` (non-rejecting)
- ~~`skill-permissions.ts`~~ — replaced by the `beforeToolCall` hook on the pi Agent (verified by Spike #4c)

**Worker system** (under `packages/core/src/workers/`):

- `worker-runtime.ts` (~50 lines) — `WorkerRuntime` interface: `dispatch(task: WorkerTask, callbacks: WorkerCallbacks) → Promise<WorkerResult>`, `steer(workerId, message)`, `abort(workerId)`, `waitForIdle(workerId)`
- `pi-runtime.ts` (~220 lines, revised in v2.2) — implements `WorkerRuntime` using `@mariozechner/pi-coding-agent`'s SDK. For new tasks: creates a pi `AgentSession` per task with **file-backed `SessionManager.create(cwd, sessionDir)`** (not in-memory — see "Session persistence"), then persists `session.sessionFile` to the workers table. For resume (both voice-pause resume and restart-safe crash recovery): reads `session_file` from the workers table, calls **`SessionManager.open(session_file, sessionDir)`**, passes into `createAgentSession({ sessionManager })`. Falls back to a fresh-spawn path if the session file is missing or corrupted. Wires `customTools` with Neura's tool adapter, installs the `beforeToolCall` hook on `session.agent` for `allowed-tools` enforcement (verified Spike #4c), subscribes to the event stream via `VoiceFanoutBridge.push` (synchronous, non-blocking — see "Voice listener async fanout"), handles errors encoded in the event stream via pi's `stopReason: "error" | "aborted"` pattern. Verified end-to-end by Spike #4e (restart-safe resume completed 3 uploads correctly — 1 in session A, 2 in session B after dispose + open).
- `voice-fanout-bridge.ts` (~150 lines, NEW in v2.1) — decoupled voice queue that drains asynchronously so the pi agent loop is never stalled by Grok websocket latency. Coalesces text deltas within a 250ms budget window. See "Voice listener async fanout" section for the full design.
- `claude-code-runtime.ts` (~250 lines — **fallback, NOT built in the primary implementation path**) — implements `WorkerRuntime` using Claude Code CLI subprocess. Only built if pi-runtime hits an unforeseen issue. Spike #1 validated this path.
- `agent-worker.ts` (~200 lines, revised in v2.1) — orchestrator-side lifecycle: spawn via `WorkerRuntime.dispatch`, track worker state in PGlite, route events through the `VoiceFanoutBridge`, persist on completion. **Crash detection is via pi's `stopReason` + rejected promise from `session.prompt()`, not subprocess liveness.** Approach D is in-process, so a pi error surfaces as an event or a thrown exception — no `child_process` `'exit'` events to watch.
- `clarification-bridge.ts` (~150 lines) — the `request_clarification` pi custom tool. Its `execute` handler calls `grokSession.interject(question, { immediate: true })`, awaits the next user turn via the existing transcript pipeline, returns the answer as the tool result. Simultaneously fires `void dispatchPromotionWorker(...)` (no await) to create a draft skill from the exchange.
- `worker-cancellation.ts` (~80 lines) — handles SIGINT/SIGTERM, user "stop" voice commands, presence transitions. Calls `session.agent.abort()` which fires the AbortSignal → propagates into active tool `execute` functions → tools clean up → agent emits `agent_end` with `stopReason: "aborted"`.
- `promotion-templates.ts` (~100 lines) — prompt templates for skill-authoring pi sessions.
- `neura-tools.ts` (~220 lines, revised in v2.1, vision removed in v2.3) — adapts Neura's existing tools into pi `AgentTool<TSchema>` objects. **Worker-side tool names from `packages/core/src/tools/`:** `remember_fact` / `recall_memory` / `update_preference` / `invalidate_fact` / `get_timeline` / `memory_stats` (memory), `create_task` / `list_tasks` / `get_task` / `update_task` / `delete_task` (tasks), `get_current_time` (time), `enter_mode` (presence). **Vision tools (`describe_screen`, `describe_camera`) are deliberately NOT in the worker set** — see the "orchestrator owns vision" discussion below. Each tool is a TypeScript function whose `execute` calls the existing Neura tool handler. Registered via the `customTools: [...]` option when calling `createAgentSession()`.
- `index.ts` — barrel export

**Deleted from original design** (because pi provides them):

- ~~`packages/core/src/mcp/neura-mcp-server.ts`~~ — no MCP server, custom tools plug directly into pi
- ~~`packages/core/src/mcp/mcp-tool-adapter.ts`~~ — same
- ~~`packages/core/src/mcp/` directory~~ — gone entirely from Phase 6. MCP may still be relevant for exposing Neura's tools to OTHER agents (Claude Code, Cursor) in Phase 9+, but that's separate scope.

**Tool system additions:**

- `packages/core/src/tools/skill-tools.ts` — built-in tools exposed via the existing Neura tool router: `create_skill`, `run_skill`, `list_skills`, `import_skill` (local filesystem paths only — no URL/git), `promote_skill` (clears the `disable-model-invocation` flag)
- Patches to `packages/core/src/tools/tool-router.ts` — add `handleSkillTool` branch
- Patches to `packages/core/src/tools/registry.ts` — add `skillToolDefs`

**Types** (in `packages/types/src/`):

- `skills.ts` — `NeuraSkill` (pi's `Skill` shape extended with `allowedTools: string[]` parsed from the `allowed-tools` frontmatter field, and `metadata: Record<string, unknown>` parsed from the `metadata:` nested field). `SkillLocation` enum. No custom frontmatter types — the format is pure Agent Skills spec, so there's no Neura-specific frontmatter type.
- `workers.ts` — `WorkerTask`, `WorkerResult`, `WorkerCallbacks`, `WorkerStatus` (values: `spawning | running | blocked_clarifying | idle_partial | completed | failed | crashed | cancelled`). The `idle_partial` status is new in v2.1 — it means "session went idle after a user-initiated pause, transcript preserved by file-backed SessionManager, waiting for resume prompt." The `crashed` status is applied by the core-startup recovery sweep to any workers left in `running` or `blocked_clarifying` when the core died.

**Store layer** (under `packages/core/src/stores/`, FLAT — not nested):

- `worker-queries.ts` — PGlite queries for worker lifecycle (CRUD on `workers` table). Columns: `worker_id`, `task_type`, `task_spec`, `status` (`spawning` | `running` | `blocked_clarifying` | `idle_partial` | `completed` | `failed` | `crashed` | `cancelled`), `started_at`, `last_progress_at`, `result_json`, `error_json`, **`session_file` TEXT NULL (filesystem path to the pi JSONL session file when the worker uses a file-backed SessionManager — required for restart-safe resume, verified by Spike #4e)**, **`session_id` TEXT NULL (pi's sessionId, stored for cross-reference and logging; not sufficient alone for reopen because pi's API is path-addressed)**. On core startup, the recovery sweep: any `running` or `blocked_clarifying` workers are marked `crashed` with reason `core_restarted`; any `idle_partial` workers with a valid `session_file` on disk stay `idle_partial` and wait for a user resume intent — their transcripts are intact.
- `skill-usage-queries.ts` — lightweight PGlite queries for skill MRU tracking. Columns: `skill_name`, `last_used_at`, `use_count`. Updated whenever `run_skill` dispatches a worker with that skill. Used by `skill-registry.getPromptContext()` for MRU eviction when the skill catalog exceeds the token budget.
- Patches to `migrations.ts` — adds `workers` table, adds `skill_usage` table, and adds nullable `proto_skill_path` column to existing `work_items` table

**Grok provider patches:**

- `packages/core/src/providers/grok-voice.ts` — adds new public method `interject(message: string, options: InterjectOptions) → Promise<void>`. Contract:
  - `immediate: true` — send via `response.create` during active state, breaking current response if necessary. Used for clarification requests that cannot wait.
  - `immediate: false` — queue for next natural turn boundary. Used for progress updates.
  - If called during passive presence, transitions through wake-then-speak flow using existing presence manager logic
  - Rate-limited to one interject per 10 seconds EXCEPT for clarification responses and worker completion announcements (which bypass the rate limit)
- After `create_skill` tool result arrives, call `session.update` with the new skill injected into the catalog (Spike #2 validated this takes ~90ms mid-session)

**Presence integration:**

- `packages/core/src/presence/presence-manager.ts` — add handling for `worker_progress` events. Active: route to `grokSession.interject({ immediate: false })`. Passive: queue until next active transition, coalesce to a summary.

**Tests** (colocated):

- `skill-loader.test.ts`, `skill-registry.test.ts`, `skill-watcher.test.ts` (no parser/validator tests — pi owns those)
- `pi-runtime.test.ts` (mocks pi's `createAgentSession`), `agent-worker.test.ts`, `clarification-bridge.test.ts`, `worker-cancellation.test.ts`
- `neura-tools.test.ts`
- `skill-tools.test.ts`
- Integration test: full skill creation loop with a real pi session (in-memory session manager, mocked xAI responses via pi's `faux` provider)

**New runtime dependency:**

- `@mariozechner/pi-coding-agent` (MIT, 10.5 MB unpacked, 20 transitive deps). Add to `packages/core/package.json` `dependencies`.
- `@mariozechner/pi-ai` pulled transitively by pi-coding-agent — no explicit dep needed.
- `@sinclair/typebox` pulled transitively — used for `AgentTool` parameter schemas, no explicit dep needed.

**Deleted runtime dependencies from original design:**

- ~~`@modelcontextprotocol/sdk`~~ — no MCP server
- ~~`chokidar`~~ — still needed for `skill-watcher.ts`, keep
- ~~`gray-matter`~~ — pi handles frontmatter parsing internally, can be removed from Neura's direct deps

### Hot-load race condition (state machine)

When `create_skill` succeeds, the new skill must become usable in the same voice session without a restart. Grok is often mid-response when the tool result arrives. State machine:

```
IDLE ──create_skill tool call──▶ PENDING_LOAD
   │                                   │
   │                                   │ worker succeeds
   │                                   ▼
   │                           SKILL_WRITTEN
   │                                   │
   │                                   │ registry reload
   │                                   ▼
   │                       AWAITING_TURN_BOUNDARY
   │                                   │
   │                                   │ Grok response.done
   │                                   ▼
   │                           SESSION_UPDATING
   │                                   │
   │                                   │ session.update ack
   │                                   ▼
   └────────────────────────────── LOADED (new skill active)
```

**Key rule:** The skill is added to the registry immediately upon worker success (available to `list_skills` and `run_skill`), but the Grok system prompt update waits for the current response to complete. The user can't trigger the new skill by voice until `LOADED`, but a directly dispatched `run_skill` tool call from another context works immediately.

**If Spike #2 fails** and session.update doesn't work mid-session, this state machine collapses: the user has to explicitly end the turn ("Thanks — now try it") before Neura can use the new skill. The demo script is adjusted accordingly.

### Worker crash recovery (rewritten in v2.1 for in-process runtime)

**v2 had this wrong.** The original crash recovery section was written for a subprocess architecture (Approach A) and talked about `child_process` exit events and MCP channel liveness. Approach D runs pi in-process, so there's no subprocess to watch and no MCP channel to monitor. The recovery model is fundamentally different.

**What can fail in an in-process runtime:**

1. **Tool execute throws unhandled.** Pi's Agent catches thrown errors and encodes them as assistant messages with `stopReason: "error"`. `session.prompt()` resolves (not rejects) and emits `agent_end`. Neura observes this via the event stream.
2. **LLM API call fails.** Pi retries per its configured `maxRetryDelayMs` policy. If all retries fail, same as above — synthetic error message, `agent_end` fires.
3. **Unhandled promise rejection in a listener or hook.** This is the only path that can actually crash the Neura core process. Mitigation: every listener and `beforeToolCall` hook is wrapped in a try/catch at registration time, plus a `process.on('unhandledRejection')` handler at Neura core startup that logs and continues.
4. **OOM or native crash of the Node process.** Kills Neura core outright. Recovery happens at next startup by reading the file-backed session state (see "Session persistence").

**On Neura core startup (authoritative recovery sweep):**

1. Query `workers` table for rows where `status IN ('spawning', 'running', 'blocked_clarifying')`. Any row in one of these states means the worker was **mid-execution** when the core died — the agent may have been running a tool call, waiting on an LLM response, or holding a blocking tool result. The JSONL file, if any, may contain a partial assistant message or an incomplete tool round-trip.
2. Mark every such row as `crashed` with reason `'core_restarted'`. **This is terminal in Phase 6** — mid-run crash recovery is explicitly out of scope (see Resume semantics below).
3. Query `workers` table for rows where `status = 'idle_partial'`. These are workers that completed a user-initiated pause BEFORE the crash — their last transition was an `agent_end` following a steer-pause, so the JSONL is in a clean state (last entry is an assistant "paused" message, no half-finished tool call). For each such row:
   - If `session_file` is non-null and the file exists on disk: leave the row as `idle_partial`, it remains resumable via `SessionManager.open()`
   - Otherwise: mark as `crashed` with reason `'session_file_missing'`
4. For each `idle_partial` or `crashed` worker with `last_progress_at` > 10 minutes ago, log a warning
5. On next active presence transition, emit an ambient summary: _"Your previous session had 2 unfinished tasks — want me to pick them back up?"_ Only `idle_partial` rows are offered for resume; `crashed` rows are offered for retry-from-scratch.

**The state machine in one sentence:** only rows that were already `idle_partial` before the crash are recoverable after a crash. Anything that was `running` or `blocked_clarifying` becomes `crashed` and terminal. This matches exactly what Spike #4e validated — a clean pause → dispose → reopen round-trip — and stays inside the boundary where pi's `SessionManager.open()` is known to work.

**Mid-task failure detection:**

Because pi is in-process, failures surface as either:

- **`tool_execution_end` with `isError: true`** — a tool's execute threw. Neura's event listener logs the error and decides whether to continue (agent observes and reasons) or abort (`session.agent.abort()`).
- **`agent_end` with a `stopReason`** — the turn ended. What Neura does depends on which `stopReason` and what action (if any) Neura took during the turn. See the authoritative mapping below.
- **Rejected promise from `session.prompt()`** — happens if an unhandled exception escapes pi's own error catching. Rare but possible. Neura wraps the `prompt()` call in a try/catch at the `agent-worker.ts` dispatch level, and on rejection marks the worker `failed`.

**Authoritative `stopReason` → `WorkerStatus` mapping (single source of truth):**

| `stopReason`          | Context                                                                          | Resulting `WorkerStatus`                      | Notes                                                                                                                                                  |
| --------------------- | -------------------------------------------------------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `"stop"`              | Worker was in a pause flow (Neura sent a steer-pause)                            | `idle_partial`                                | Natural completion of the pause handling turn. The agent finished its `paused` acknowledgment and ended cleanly. JSONL is in a clean state. Resumable. |
| `"stop"`              | Worker was running normally                                                      | `completed`                                   | Task ran to completion.                                                                                                                                |
| `"aborted"`           | Neura called `session.agent.abort()` (user said "stop/cancel", SIGINT, etc.)     | `cancelled`                                   | User-driven cancel. Terminal. Distinct from `failed`.                                                                                                  |
| `"error"`             | Pi captured an error anywhere in the turn (tool throw, LLM API exhaustion, etc.) | `failed`                                      | Terminal. Error message surfaced via voice.                                                                                                            |
| (any other / unknown) | —                                                                                | `failed` with `reason: "unknown_stop_reason"` | Defensive default. Terminal.                                                                                                                           |

**Key distinctions:**

- `"stop"` is a natural completion — it's what happens when the agent voluntarily ends a turn, including the "paused" acknowledgment turn. Pause uses `"stop"`, NOT `"aborted"`. This was verified empirically by Spike #4c.
- `"aborted"` ONLY happens when Neura calls `session.agent.abort()` imperatively. This is the cancel path, never the pause path. Workers with `"aborted"` are `cancelled`, not `failed`.
- The pause-vs-complete distinction at `"stop"` depends on whether Neura initiated the turn as a pause steer. Neura's `agent-worker.ts` tracks a `pendingPause` flag set when the pause steer is sent and cleared on the next `agent_end`. If the flag is set when `agent_end` fires with `stopReason: "stop"`, the worker transitions to `idle_partial`; otherwise `completed`.

**There is no "heartbeat" primitive in Approach D.** The event stream IS the heartbeat — if the agent is making progress, events flow. If events stop flowing without an `agent_end`, something is stuck. Neura's `agent-worker.ts` implements a soft progress-stall watchdog:

- If no event has arrived for 120 seconds AND the worker hasn't been in a known-slow step (large file upload, long web search), log a warning but don't kill the session
- If no event for 600 seconds (10 minutes), call `session.agent.abort()` and mark the worker as `failed` with reason `progress_stalled`

**Resume semantics (Phase 6 scope):**

- **Pause → resume (user-initiated):** supported. The pause/resume flow in the "User-initiated pause and resume" section writes a file-backed JSONL, drives the session to `agent_end` via a steer-pause, and leaves the worker in `idle_partial`. A fresh `session.prompt()` on the same (or reopened) session resumes naturally.
- **Pause → restart → resume (user paused, then the core died while idle):** supported. The JSONL was in a clean state at pause time, the workers row is `idle_partial`, and the startup sweep preserves it. Neura reads `session_file` from the workers table, calls `SessionManager.open(session_file)`, passes into `createAgentSession({ sessionManager, customTools })`, and sends a fresh prompt: "The task was interrupted by a system issue. Please continue from where you left off." Verified end-to-end by Spike #4e.
- **Mid-run crash (agent was actively `running` or `blocked_clarifying` when the core died):** **NOT supported in Phase 6.** The JSONL may have a partial tool result, an incomplete assistant message, or a pending blocking-tool round-trip — recovering this cleanly would require pi to support "resume from mid-turn" which it does not. Phase 6 marks these `crashed` (terminal) and offers retry-from-scratch. Spike #4e validated the clean pause→reopen path only; there is no spike for mid-run crash, and the design does not claim one. If Phase 7 wants real mid-run recovery, it needs either pi support for mid-turn resume or a Neura-side transcript-repair layer — both are non-trivial and explicitly out of this phase.

### Worker cancellation

Triggers:

1. **User says "stop" or "cancel that" during voice session** — existing transcript pipeline detects the intent, orchestrator calls `WorkerRuntime.abort(workerId)` which fires pi's AbortSignal, which propagates to every in-flight tool call (since every `execute` receives the signal).
2. **SIGINT/SIGTERM on core** — orchestrator calls `abort()` on all active workers before shutting down, with a 5-second grace period.
3. **Presence transitions to idle (timeout)** — long-running workers continue running; short-lived workers (<30s expected duration) are cancelled. User preference configurable in Phase 7.

Cancellation is near-instantaneous in Approach D because pi-agent-core propagates the abort signal synchronously into tool `execute` functions. Tools that respect the signal (e.g. `bash` aborts the running shell command, file writes abort via the signal) stop cleanly. Tools that ignore the signal run to completion but their result is discarded. Workers report `cancelled` status immediately when the agent's `agent_end` event fires with `stopReason: "aborted"` — per the authoritative mapping table above, `"aborted"` is exclusively the imperative-cancel path.

**Difference from user-initiated pause:** cancel is terminal (worker is done, state is discarded). Pause is resumable (worker state is preserved, resume later). Different primitives, different voice intents.

### User-initiated pause and resume (CORRECTED in v2.1)

**What the v2 draft got wrong** — v2 described pause and resume as two sides of the same `streamingBehavior: "steer"` primitive, with the pi AgentSession "holding an idle run waiting for steer-resume." **Spike #4c proved this model is incorrect.** Pi's Agent loop runs to `agent_end` when the pause is processed — at that point the `prompt()` call resolves and the session becomes genuinely idle, not "paused." There is no "held run" state.

The correct model is simpler. Pause is a steer. Resume is a fresh prompt on an idle session whose conversation history has been preserved by the SessionManager.

**The verified flow** (Spike #4c — `tools/spikes/phase6/pi-test/spike4c-resume.mjs`):

1. User is mid-task. An `agent-worker` is running a skill that's uploading documents. Upload #1 is in flight.
2. User says "pause the upload, I need to make a call."
3. Grok transcribes. Neura's voice intent detection routes this to a "pause" handler.
4. Handler calls:
   ```typescript
   await session.prompt(
     "PAUSE. The user stepped away for a phone call. Stop after the current tool call (if any) finishes. Do not start any more work. Say 'paused' and wait.",
     { streamingBehavior: 'steer' }
   );
   ```
5. Pi enqueues the steering message in `session.steeringQueue`. At the next tool-call boundary (when the in-flight upload finishes), pi's agent loop polls `getSteeringMessages()`, drains the queue, and injects the message into the conversation.
6. The agent's next reasoning step incorporates the steering message, decides to stop, says "paused", and **`agent_end` fires naturally**. The original `session.prompt()` call resolves at this point.
7. **The session is now IDLE.** `isStreaming` is false, `streamingMessage` is undefined, but the conversation transcript is preserved in `session.state.messages`.
8. Neura updates the workers table (via `worker-queries.ts`) to set status `idle_partial` (a Phase 6 status meaning "session is idle, task was paused, conversation is preserved"). Neura surfaces "Worker paused" via `grokSession.interject()`.
9. User makes their phone call. **This can last seconds, minutes, or hours.** The session is truly idle — pi is not holding any state beyond the in-memory conversation transcript. No event loop overhead, no pending promises, no memory growth.
10. User says "ok, resume the upload."
11. Neura's voice intent detection routes to a "resume" handler.
12. Handler calls:
    ```typescript
    await session.prompt(
      "OK, I'm back. Please resume the task. Continue with the remaining uploads, then finish the rest of the plan."
    );
    ```
    **NOTE: No `streamingBehavior` parameter.** There's nothing to steer — the session is idle. This is a fresh turn that pi appends to the existing transcript.
13. Pi runs a fresh agent turn. The system prompt + full prior transcript (original task + upload #1 success + pause instruction + agent's "paused" response + resume instruction) are sent to the LLM.
14. The agent reads the transcript, figures out which steps are done and which are pending, and continues. **In Spike #4c this worked on the first attempt** — the agent correctly picked up with upload #2, then upload #3, then `allowed_list`, then attempted `secret_delete` (which was blocked by `beforeToolCall`).

**Spike #4c concrete numbers:**

- Upload #1 completed during Phase 1
- 20-second idle period during Phase 3 (simulated phone call)
- On resume, uploads #2 and #3 completed successfully in the correct order
- Agent did not re-upload #1 (it remembered via transcript)
- Agent did not skip any steps
- Total session elapsed: 42.1 seconds, of which 20 seconds was the idle period

**Why this is simpler than v2 described:**

- No special "paused" session state on the pi side — pi's `AgentSession` just goes idle normally
- No `streamingBehavior: "steer"` on resume — just a normal `session.prompt()`
- The complicated "held run" semantics don't exist
- The memory cost of a paused session is just the stored transcript, not an in-flight agent loop

**What's NOT supported:**

- **Pause within a single long tool call.** Pi's steering drains only at the tool-call boundary. If the worker is mid-`curl --upload @big-file.pdf`, the pause waits for that curl to finish before taking effect. For the CMS upload use case this is actually what the user wants (no half-uploaded files), but it's worth naming.
- **Pause across a core restart — WITHOUT file-backed session persistence.** The v2 doc recommended `SessionManager.inMemory()`. If the core crashes during the idle period, the transcript is lost and the resume prompt arrives to an empty session. **v2.1 recommends file-backed persistence instead** — see "Session persistence" below.
- **Pause while a worker is blocked inside `request_clarification`.** The worker is awaiting a user voice response on a blocking tool call. A pause would need to first resolve the pending clarification before steering. Not implemented in Phase 6 — documented as a Phase 7 improvement.
- **Pausing creative / open-ended tasks.** A task like "brainstorm five product names" has no natural state to resume — when the agent resumes, its next turn might be different from what it was about to generate. Phase 6 accepts this as an edge case. Skill authors can flag creative skills via `metadata.neura_resumable: false` (advisory only, not enforced in v2.1, reserved for Phase 7).

**Voice intent detection** (keyword-based for Phase 6):

- "pause" / "hold on" / "wait" / "stop for a moment" → pause
- "resume" / "continue" / "go ahead" / "keep going" / "I'm back" → resume
- "cancel" / "stop for good" / "abort" / "never mind" → cancel (different primitive, see Worker cancellation — cancels the session permanently instead of leaving it idle)

Keyword-based is fine for v2.1. A proper intent classifier lives in Phase 7.

### Session persistence (file-backed, revised in v2.2)

**v2 recommended `SessionManager.inMemory()` for worker sessions.** Spike #4c revealed a gap: if the core crashes during a pause idle period, the in-memory conversation transcript is lost, and a subsequent resume prompt arrives to an empty session.

**v2.1 switched to file-backed `SessionManager.create(cwd, sessionDir)`.** Correct. But it described the **reopen** flow using `SessionManager.create()` again with "the original `sessionId`" — that API doesn't exist. `create()` always writes a new session file. Codex caught this in round 2.

**v2.2 uses the actual pi reopen API: `SessionManager.open(sessionFile)`** — pi's session-manager.d.ts:303 exposes `static open(path: string, sessionDir?: string, cwdOverride?: string): SessionManager`. Verified end-to-end by Spike #4e (22.1s run): create session → start task → pause → `session.dispose()` → `SessionManager.open(sessionFile)` → `createAgentSession({ sessionManager })` → resume prompt → task continues. Same `sessionId`, full history, no re-uploads.

**Key details from Spike #4e:**

- `SessionManager.create(cwd, sessionDir)` writes a JSONL at `<sessionDir>/<timestamp>_<uuid>.jsonl`. Path is available immediately via `session.sessionFile` (the getter is on `AgentSession`, delegating to the manager).
- `session.sessionFile` is the **only identifier Neura needs to persist**. The `sessionId` alone is insufficient — pi's reopen is path-addressed, not id-addressed.
- `session.dispose()` releases listeners and detaches from the Agent, but the JSONL on disk is untouched. A crashed core skipping dispose is also fine — the JSONL was flushed on each message.
- `SessionManager.open(sessionFile, sessionDir)` re-reads the JSONL, rebuilds the entry tree, preserves the same `sessionId`, and is ready to be passed into `createAgentSession({ sessionManager })`.
- When rebuilding, **custom tools must be re-registered with the same names** via `createAgentSession({ customTools })`. Pi matches tool-call messages in the saved history to the current tool registry by name — this is how Spike #4e's reopened session knew how to continue calling `fake_upload` without re-running the already-uploaded doc.

**Implementation for `pi-runtime.ts`:**

```typescript
// Worker spawn (new task)
const sessionDir = join(agentDir, 'sessions');
const sessionManager = SessionManager.create(cwd, sessionDir);
const { session } = await createAgentSession({
  cwd,
  agentDir,
  model,
  sessionManager,
  customTools: buildNeuraTools(),
});
await workerQueries.update(workerId, {
  session_id: session.sessionId,
  session_file: session.sessionFile, // path — this is the load-bearing one
});

// Worker resume (after restart OR after a voice-pause idle period)
const row = await workerQueries.get(workerId);
if (!row.session_file || !existsSync(row.session_file)) {
  // session file missing — fall back to spawn a fresh worker
  throw new WorkerResumeError('session file missing or corrupted');
}
const sessionManager = SessionManager.open(row.session_file, sessionDir);
const { session } = await createAgentSession({
  cwd,
  agentDir,
  model,
  sessionManager,
  customTools: buildNeuraTools(), // must match names used in original session
});
await session.prompt('Resume your task. Pick up where you left off.');
```

**Tradeoffs:**

- Small disk I/O on every turn — probably a few hundred bytes written per tool call. Spike #4e saw a 2706-byte JSONL after 1 upload + a steer-pause exchange.
- Sessions accumulate on disk — Phase 6 includes a cleanup job that garbage-collects sessions older than 30 days (stored as a config setting, purged on next core startup).
- Resume across a restart is now survivable for the pause→restart path — core dies, restarts, the workers table has an `idle_partial` row with `session_file`, Neura calls `SessionManager.open()` on the path, sends a resume prompt. Mid-run crashes stay terminal (see "Worker crash recovery").
- Custom tool registry must be reconstructable on resume. Neura's tool set is defined in `neura-tools.ts` and is identical across sessions, so this is fine. If a skill registers dynamic tools (Phase 7+ territory), resume becomes more delicate.

**What this does NOT survive:**

- User switching machines (session files are local)
- Corrupted session file (no checksumming in pi)
- Disk failures
- Tool registry changes between create and reopen (if Neura renames a tool, saved tool_call entries referring to the old name won't match)

All of these are out-of-scope for Phase 6. The workers table query layer has a `fallback-to-fresh-spawn` branch for the missing/corrupted file case.

### Voice listener async fanout (NEW in v2.1)

**The concern Codex flagged.** Pi's `Agent.subscribe()` awaits listener promises in subscription order, serially — per the `processEvents` method in pi-agent-core's `agent.ts`. If Neura's voice-bridge listener does:

```typescript
session.subscribe(async (event) => {
  if (event.type === 'message_update') {
    await grokSession.interject(event.assistantMessageEvent.delta, { immediate: false });
  }
});
```

...and `grokSession.interject()` takes ~200-500ms per call (due to Grok WebSocket round-trip latency), then for a verbose response with 50 text deltas, the agent loop is artificially stalled by 10-25 seconds waiting on voice. That's a real latency/deadlock risk, not "natural back-pressure."

**The v2.1 fix: async fanout with a decoupled voice queue.**

The voice-bridge listener is NOT `async` — it's synchronous, and all it does is push the event into an in-process queue. A separate worker task drains the queue and calls `grokSession.interject()` at its own pace, coalescing deltas if the queue is backing up:

```typescript
// In agent-worker.ts or a dedicated voice-bridge.ts

class VoiceFanoutBridge {
  private queue: VoiceEvent[] = [];
  private draining = false;
  private coalesceBudgetMs = 250; // coalesce deltas arriving within this window
  private logger = new Logger('voice-fanout-bridge');
  // Set by agent-worker when it sends a pause steer. Cleared on agent_end.
  // Tells the bridge "don't speak Done. on the next stop — it's a pause ack."
  private pendingPause = false;

  constructor(private grokSession: GrokVoiceProvider) {}

  // Called by agent-worker immediately before sending a pause steer, so the
  // next agent_end with stopReason "stop" stays silent instead of saying "Done."
  setPendingPauseFlag(): void {
    this.pendingPause = true;
  }

  // Synchronous listener — pi's agent loop is never blocked
  push(event: AgentEvent): void {
    if (event.type === 'message_update') {
      const delta = event.assistantMessageEvent?.delta;
      if (typeof delta === 'string' && delta.length > 0) {
        // Strip tool-call JSON artifacts that Grok emits into the assistant text
        // stream (e.g. `{"docName":"doc-alpha.pdf"}`). Spike #4 observed these leak
        // into message_update deltas — they are meant for pi's tool invocation path,
        // not for speech. If we hand them to the voice pipeline verbatim the user
        // hears Neura read out raw JSON. Filter to human-readable prose only.
        const cleaned = stripToolCallArtifacts(delta);
        if (cleaned.length > 0) {
          this.queue.push({ type: 'text_delta', text: cleaned, ts: Date.now() });
        }
      }
    } else if (event.type === 'tool_execution_start') {
      this.queue.push({ type: 'tool_start', toolName: event.toolName, ts: Date.now() });
    } else if (event.type === 'tool_execution_end') {
      this.queue.push({
        type: 'tool_end',
        toolName: event.toolName,
        isError: event.isError,
        ts: Date.now(),
      });
    } else if (event.type === 'agent_end') {
      // agent_end carries a stopReason — different stops need different voice
      // affordances (completion vs pause vs cancel vs error). Capture the reason
      // so routeNonTextEvent can decide whether to speak at all.
      this.queue.push({
        type: 'agent_end',
        stopReason: event.stopReason ?? 'stop',
        ts: Date.now(),
      });
    }
    // Fire-and-forget drain, but catch errors so they don't become unhandled rejections.
    this.drain().catch((err) => {
      this.logger.error({ err }, 'voice fanout drain failed');
      this.draining = false; // release the guard so next push() can restart the drain
    });
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.queue.length > 0) {
        const first = this.queue[0];
        if (first.type === 'text_delta') {
          // Coalesce contiguous text deltas that arrive within the budget window.
          // The window actually waits — we sleep for coalesceBudgetMs, then drain
          // everything that accumulated while we slept. Without the sleep, the loop
          // only consumes what's already queued at entry and the "window" collapses
          // to zero (the bug in the v2.1 sketch).
          await this.sleep(this.coalesceBudgetMs);
          let coalesced = '';
          while (this.queue.length > 0 && this.queue[0].type === 'text_delta') {
            coalesced += (this.queue.shift() as TextDeltaEvent).text;
          }
          if (coalesced.length > 0) {
            await this.grokSession.interject(coalesced, { immediate: false });
          }
        } else {
          // Non-text events (tool_start, tool_end, agent_end) send as-is, no coalescing.
          const ev = this.queue.shift()!;
          await this.routeNonTextEvent(ev);
        }
      }
    } finally {
      this.draining = false;
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async routeNonTextEvent(ev: VoiceEvent): Promise<void> {
    switch (ev.type) {
      case 'tool_start':
        await this.grokSession.interject(`Running ${ev.toolName}...`, { immediate: false });
        break;
      case 'tool_end':
        if (ev.isError) {
          await this.grokSession.interject(`${ev.toolName} failed.`, { immediate: false });
        }
        break;
      case 'agent_end':
        // agent_end semantics depend on stopReason (see "Authoritative
        // stopReason → WorkerStatus mapping" in Worker crash recovery). The
        // bridge only speaks on stopReason "stop" AND only when the
        // agent-worker didn't flag the turn as a pause handler. The
        // agent-worker tracks this via a pendingPause flag and provides it
        // to the bridge via setPendingPauseFlag() so the bridge can stay
        // silent on pause acknowledgment turns.
        //   "stop" + not pause   — natural completion → speak "Done."
        //   "stop" + pause       — pause acknowledged → stay silent (user
        //                          knows they paused; agent-worker surfaces
        //                          "paused" to the UI via state transition)
        //   "aborted"            — imperative cancel → stay silent
        //   "error"              — agent-worker surfaces the real error
        //   anything else        — silent default
        if (ev.stopReason === 'stop' && !this.pendingPause) {
          await this.grokSession.interject('Done.', { immediate: false });
        }
        this.pendingPause = false; // clear after any agent_end
        break;
    }
  }
}

// Regex filter for tool-call JSON artifacts leaking into the assistant text
// stream. Observed in Spike #4: `{"docName":"doc-alpha.pdf"}paused`. Strip any
// top-level JSON object that appears in the delta. Leave the surrounding prose.
// Conservative — if the delta is JSON-only, returns an empty string.
function stripToolCallArtifacts(text: string): string {
  // Matches `{...}` that looks like an object literal. Non-greedy, single-line.
  // This is a heuristic, not a parser — it's fine if a rare literal-prose
  // mention of `{ x: 1 }` gets nuked, because we'd rather drop one message than
  // read raw JSON out loud.
  return text.replace(/\{[^{}\n]*?\}/g, '').trim();
}

// Wiring
const voiceBridge = new VoiceFanoutBridge(grokSession);
session.subscribe((event) => {
  voiceBridge.push(event); // synchronous — no await
});
```

**Why the sleep is the fix.** The v2.1 sketch set `cutoff = Date.now() + 250` inside the drain loop and then ran a tight inner `while` over `this.queue`. Since `drain()` is invoked at the tail of each synchronous `push()`, and JavaScript's event loop doesn't deliver new events until the current microtask completes, the inner loop only ever saw whatever was queued at the moment drain was called. The "window" never actually waited for future deltas — it collapsed to zero. The fix: do an explicit `await sleep(coalesceBudgetMs)` before draining the text batch. During that 250ms, pi's subsequent `push()` calls append new deltas to the queue (no contention — `push()` is synchronous), and when the sleep returns, we drain everything that accumulated. One `interject()` call per ~250ms window instead of one per delta.

**Key properties:**

- The synchronous `push()` returns immediately, so pi's `Agent.processEvents` doesn't wait for voice round-trips.
- The decoupled `drain()` task runs in the background, coalescing text deltas within a 250ms window so we don't fire 50 separate interjects for 50 deltas. Instead we fire maybe 3-5 interjects with combined text.
- If the voice bridge itself hangs (e.g., Grok websocket dies), the queue grows but pi's agent loop is unaffected. Neura can detect a stuck voice bridge via queue depth monitoring (Phase 7 observability).
- Ordering is preserved — events drain FIFO, text deltas coalesce only with contiguous text deltas at the head of the queue.

**Cost:** ~150 lines of well-tested code in `packages/core/src/workers/voice-fanout-bridge.ts`. This is a new file in v2.1 that wasn't in the v2 file list.

**Alternative considered:** use pi's `afterToolCall` hook instead of the subscribe listener for tool events. This works for tool events but doesn't solve the text-delta problem — `message_update` events only come via subscribe. So the fanout queue is needed regardless. Going with the queue for all event types for consistency.

### Worker concurrency (briefly two active workers during promotion)

Phase 6 does NOT ship a general worker pool. However, during the clarification-capture flow there are briefly TWO active pi AgentSessions:

1. The **parent session** (e.g. running `red-test-triage` or a research task) is blocked on a `request_clarification` custom tool call. Its session is idle, holding the pending tool-call result.
2. The **promotion session** (write-skill task) is spawned synchronously by `clarification-bridge.ts` as soon as the user's answer arrives. It runs in a separate pi AgentSession — same process, different `Agent` instance. It runs to completion (typically 10-30 seconds), writes the draft skill, and exits.

The parent's `request_clarification` tool call resolves the moment the user answers (not when the promotion session finishes) — the parent resumes in parallel with promotion, not after it. Both sessions share the same Neura core process (Approach D is in-process) but have independent `Agent` state, independent tool invocations, and independent event streams.

**Bounds:** the concurrency ceiling is exactly 2 during promotion, exactly 1 otherwise. Phase 7 will lift this with a real worker pool. Phase 6 does not need one.

### `run_skill` is async (returns worker_id, streams progress via interject)

Decision (previously an open question): `run_skill` dispatches a worker and returns immediately with a `worker_id`. It does NOT await completion. Progress surfaces via `grokSession.interject()` ambient voice updates as the worker runs. The final result is delivered as one last interject when the worker completes.

The synchronous-await alternative would block Grok's turn for the full worker duration (potentially minutes), which breaks voice turn-taking and makes long-lived workers impossible. The demo script explicitly relies on the async behavior (Neura narrates progress while the worker runs).

Implementation note: Grok sees `run_skill` return a trivial ack ("Worker dispatched, tracking as wk_abc123"). Real status comes via interject events. The tool call is not long-blocking, so it sidesteps the Spike #1 concern about blocking MCP handlers.

### Clarification protocol (via pi custom tools)

Workers use a pi custom tool (`request_clarification`) registered through `createAgentSession({ customTools: [...] })`. No MCP server is needed — the tool's `execute` function runs in the same process as Neura core, so it can directly call `grokSession.interject()` and await the transcript pipeline.

**Pi custom tool definition (`neura-tools.ts`):**

```typescript
import { Type } from '@sinclair/typebox';

export const requestClarificationTool = {
  name: 'request_clarification',
  label: 'Request Clarification',
  description:
    "Ask the user a clarifying question when you're stuck. Use this if you need context you don't have. The user's voice response is returned as the tool result.",
  parameters: Type.Object({
    question: Type.String({ description: 'Plain-language question to ask the user' }),
    context: Type.String({ description: "What you're trying to do and why you're stuck" }),
    urgency: Type.Union([Type.Literal('blocking'), Type.Literal('background')]),
  }),
  execute: async (toolCallId, params, signal) => {
    // Get the workerId from the enclosing context (set by pi-runtime.ts)
    const workerId = getCurrentWorkerId();

    // Mark the worker as blocked BEFORE interjecting
    await workerQueries.update(workerId, { status: 'blocked_clarifying' });

    try {
      // Voice-bridge the question
      await grokSession.interject(`The worker needs your input: ${params.question}`, {
        immediate: params.urgency === 'blocking',
      });

      // Wait for the user's next voice turn via the existing transcript pipeline
      // (with abort signal propagation in case the user cancels)
      const answer = await waitForNextUserTurn(signal);

      // Mark back to running
      await workerQueries.update(workerId, { status: 'running' });

      // Fire the promotion worker in parallel (don't await — let it run async)
      void dispatchPromotionWorker({
        originalTask: getCurrentTaskDescription(),
        question: params.question,
        context: params.context,
        answer,
        relatedSkill: getCurrentSkillName(),
      });

      // Return the user's answer as the tool result
      return {
        content: [{ type: 'text', text: answer }],
        details: { workerId, question: params.question, answer },
      };
    } catch (err) {
      // Decide how to revert the blocked_clarifying status based on why the
      // clarification failed. Cancellation (the user said "stop") must not
      // silently drop the worker back to `running` — it belongs in `cancelled`.
      // Pi's abort propagation throws an AbortError-shaped error; anything else
      // is a real failure (voice bridge died, transcript pipeline errored).
      if (signal?.aborted) {
        await workerQueries.update(workerId, {
          status: 'cancelled',
          error_json: { reason: 'clarification_aborted_by_user' },
        });
      } else {
        await workerQueries.update(workerId, {
          status: 'failed',
          error_json: { reason: 'clarification_bridge_error', detail: String(err) },
        });
      }
      throw err; // let pi surface it as tool_execution_end isError=true
    }
  },
};
```

**Flow:**

1. Worker (pi AgentSession) calls `request_clarification` tool during its reasoning loop
2. Pi's Agent invokes the tool's `execute` function — pi itself blocks until the function returns (Spike #4 verified `streamingBehavior` steering happens at tool-call boundaries, which is exactly the semantics we need)
3. The execute function updates the worker's status to `blocked_clarifying` via `worker-queries.ts`
4. Bridge calls `grokSession.interject()` with the formatted question — user hears the question via voice
5. Bridge awaits `waitForNextUserTurn(signal)` which resolves when the user speaks (via the existing transcript pipeline). The abort signal propagates cancellation if the user says "stop" during the clarification.
6. Once the user responds, bridge updates status back to `running`, fires the promotion worker in parallel (`void dispatchPromotionWorker(...)` — no await, runs async while parent resumes), and returns the user's answer as the tool result.
7. Pi's Agent receives the tool result and continues its reasoning loop with the clarification in its context.

**Advantages over the MCP-based design in v1:**

- **No MCP server subprocess** — the tool runs in-process, no IPC overhead
- **Abort signal propagation is native** — pi passes `signal` into `execute`, we use it to cancel the voice wait cleanly if the user cancels
- **No blocking-MCP-handler concern** — we're not going over an IPC boundary, so the MCP SDK timeout issue from Spike #1 doesn't apply here at all
- **Promotion worker is fire-and-forget** — the parent doesn't wait for promotion to finish before resuming, so the clarification-to-skill round-trip is invisible from the parent's perspective

### Promotion Worker Template

The prompt template dispatched (via a new pi AgentSession) when a clarification is captured and needs to become a durable skill:

```
You are a Neura skill-writer worker. You will synthesize a new Agent Skills–compatible skill
from a captured user clarification.

## Context

The user was asking Neura to do a task related to: {original_task_description}

A previous worker attempted the task and hit a gap. It asked the user:
  Question: {clarification_question}
  Context: {clarification_context}

The user responded:
  Answer: {clarification_answer}

## Your job

1. Decide: does this clarification fit into an existing skill (update it) or does it need a new
   skill (create one)? Check {existing_related_skills_summary}.

2. If UPDATING an existing skill:
   - Use the `read` tool (pi built-in) to load the skill at {existing_skill_path}
   - Use the `edit` tool (pi built-in) to add a new section documenting the captured knowledge
   - Preserve all existing content
   - Bump the version if present (x.y.z → x.y.z+1), or add `version: 0.1.0` if absent
   - Add/update `metadata.neura_source: clarification_capture_update` in frontmatter
   - Set `disable-model-invocation: true` (user must promote via `promote_skill`)

3. If CREATING a new skill:
   - Choose a kebab-case `name` based on the task nature (must match the directory name)
   - Write a clear `description` field (will be used for skill triggering)
   - Write a Markdown body with a "When to use" section and a "Steps" section
   - Set `metadata.neura_source: clarification_capture` in frontmatter
   - Set `disable-model-invocation: true` (user must promote via `promote_skill`)
   - Set `allowed-tools` to a space-delimited list of the minimum tools needed (e.g. `describe_screen create_task recall_memory`)
   - Use the `write` tool (pi built-in) to create `~/.neura/skills/{name}/SKILL.md`

4. On success, return a plain-text summary of what you created and where. Your final
   assistant message will be captured by Neura's event stream and surfaced to the user
   via voice.

Do NOT clear `disable-model-invocation` — that's the user's decision via `promote_skill`.
Do NOT delete any existing skills.

## Skill format reference

Agent Skills standard (per https://github.com/anthropics/skills):
- Directory structure: `<name>/SKILL.md`
- Required frontmatter: `name`, `description`
- Optional spec frontmatter used by Neura: `allowed-tools`, `disable-model-invocation`, `version`, `metadata`
- Name validation: kebab-case, a-z/0-9/hyphens only, max 64 chars, must match parent dir
- Description max 1024 chars
- Neura-specific metadata goes under the `metadata:` nested object (never as top-level fields)

## Available tools

You have access to Neura's worker-side tools (recall_memory, remember_fact, create_task, list_tasks, get_current_time, list_skills, request_clarification) and pi's built-in tools (read, write, edit, bash, grep, find, ls). Because this is a skill-AUTHORING task (taskType: promote_clarification), the `allowed-tools` enforcement is bypassed — you can use any tool needed to write the skill file correctly.

Note: `describe_screen` and `describe_camera` are NOT in the worker tool set. Vision is an orchestrator concern — Grok is the one looking at the user's screen, and any visual context workers need is passed in via the task description as text.

Stay focused on writing the skill file — do not attempt to execute it.
```

The template is stored in `packages/core/src/workers/promotion-templates.ts` and filled in at dispatch time with the actual clarification data. The promotion session is spawned via `createAgentSession` with `taskType: "promote_clarification"` so `beforeToolCall` allows all tools (see "Permissions & Trust Tiers" section).

### Skill format (pure Agent Skills spec — zero Neura fork)

```yaml
---
name: red-test-triage
description: When the user says "help me fix this", create a triage task from the failing test details the orchestrator passes in (test name, error message, suspected file, repro command) and optionally enrich with memory context. The worker does NOT access the screen — the orchestrator captures visible test output via its own describe_screen call and embeds the extracted details in the task description.
version: 0.1.0

# Pi's native trust tier field (spec-compliant, enforced by pi at formatSkillsForPrompt time)
disable-model-invocation: false

# Standard Agent Skills field (spec-compliant, enforced by Neura via beforeToolCall hook)
# Workers do NOT get vision tools — describe_screen lives on the orchestrator side.
allowed-tools: create_task recall_memory

# Agent Skills spec "arbitrary key-value" extension point for custom metadata
metadata:
  neura_source: create_skill_tool
  neura_created_by: agent-worker
  neura_created_at: 2026-04-11T00:12:34Z
---

# Red Test Triage

## When to use

The orchestrator dispatches this worker with a task description containing the captured failing test details — the user said "help me fix this" while looking at a failing test, and the orchestrator (Grok) called its own `describe_screen` tool to see what was on the user's terminal before dispatching.

## Steps

1. Parse the task description for the failing test name, error message, suspected file, and test runner.
2. Optionally call `recall_memory` with the suspected file or test name to surface prior context.
3. Call `create_task` with title, description, and priority.
4. Respond with a one-sentence confirmation.
```

**Required frontmatter fields (Agent Skills spec, validated by pi):**

- `name` (kebab-case, a-z/0-9/hyphens only, max 64 chars, must match parent directory)
- `description` (non-empty, max 1024 chars, used for skill triggering; should be specific and "pushy")

**Optional frontmatter fields (all standard Agent Skills):**

- `version` (semver string). If present, the promotion worker bumps the patch version on every update. If absent, it's added as `0.1.0` on first promotion update.
- `license` (spec-defined, free-form string). Parsed by Neura's loader, surfaced in `list_skills` / `get_skill` output so the model can reason about license before dispatching a worker.
- `compatibility` (spec-defined, ≤ 500 chars). Parsed by Neura's loader; over-length values emit a `warning` diagnostic and the skill still loads. Surfaced in `list_skills` / `get_skill` so the model can check environment requirements (e.g. "requires ffmpeg") before dispatching.
- `disable-model-invocation` (boolean, default false). When true, the skill is loaded by the registry but excluded from the Grok system prompt catalog by pi's `formatSkillsForPrompt()`. This is Neura's "draft" state. Cleared via the `promote_skill` tool to "activate" a skill. **Verified end-to-end by Spike #4d.**
- `allowed-tools` (space-delimited string per spec). When present, Neura enforces that the worker can only call tools in this list. **Required-in-practice by Neura:** see "allowed-tools absence policy" below for what happens when it's missing. **Verified end-to-end by Spike #4c.**
- `metadata` (arbitrary nested key-value mapping per spec). Used by Neura for tracking fields like `neura_source`, `neura_created_at`, `neura_created_by`. Other runtimes that don't care about these fields silently ignore them.

**There are NO Neura-invented top-level frontmatter fields in v2.1.** Every top-level field in a Neura skill is either from the Agent Skills spec or ignored by other runtimes per the spec's "unknown fields are ignored" rule. A skill authored for Neura works verbatim in Claude Code, Cursor, or any other Agent Skills consumer.

**Validation rules:**

- Frontmatter parses as valid YAML (pi's loader)
- `name` and `description` present and within length limits (pi)
- `name` matches parent directory (pi — warns but still loads per the spec's leniency)
- `name` follows the character rules (pi)
- `allowed-tools`, if present, references tool names that Neura knows about — **warning only, does NOT reject the skill** (unknown tool names just get blocked at runtime, which is the same behavior as if they were misspelled)
- Skill body is non-empty (pi — warning only)
- `metadata.neura_*` fields are not validated; they're free-form

**Notes for implementers:**

- Pi enforces Agent Skills spec rules via `loadSkills()`. Neura's `skill-loader.ts` calls pi's loader, then re-parses each returned skill's SKILL.md to extract `allowed-tools`, `metadata.*`, `license`, and `compatibility` (which pi's `Skill` type doesn't expose — confirmed by Spike #4d).
- Pi emits validation warnings as diagnostics (not errors). Neura's loader surfaces diagnostics via the CLI / logs but doesn't reject skills for warnings.
- **Skill author-facing validator**: `neura skill validate <path>` replays pi's validation plus the license/compatibility checks and exits non-zero on any diagnostic. Designed for pre-commit hooks and CI on skill repositories. Core itself never blocks skill loading — this is the strict checkpoint skill authors run before publishing.
- **`allowed-tools` absence policy (Neura-specific).** Skills without `allowed-tools` hit a Neura-specific policy that intentionally diverges from Claude Code. Claude Code treats absence as "inherits session tool set" — effectively unrestricted. Neura treats absence as "this skill is incomplete for execution." At `loadSkills()` time, Neura emits a diagnostic ("skill '<name>' has no `allowed-tools`; will run with Neura's read-only default set"). At execution time, `beforeToolCall` enforces a small read-only default tool set: `list_skills`, `recall_memory`, `get_current_time`. The user can promote the skill by editing it and adding an explicit `allowed-tools`, or by invoking it through `run_skill` with an explicit override. **This is a Neura policy choice, not a spec requirement, and it means third-party skills that rely on Claude Code's inherit-everything behavior will execute in a reduced capability mode under Neura.** The tradeoff is deliberate — Neura's long-running ambient workers are higher-risk than Claude Code's interactive sessions, and silently granting unrestricted tool access to a skill that failed to declare its needs is unsafe. Skill authors who want portability should always declare `allowed-tools` explicitly.

### Skill registry `getPromptContext()` — Level-0 budget

Method signature:

```typescript
getPromptContext(budgetTokens: number): string
```

Format (Level-0 compact catalog):

```
# Available Skills

You have these skills available. Call `run_skill` with the skill name to use one.

- red-test-triage: When the user says "help me fix this", triage failing tests from screen...
- wiki-upload: Upload files to the team wiki via the /api/pages endpoint...
- cms-upload: Upload research articles to the company CMS...
```

**Budget enforcement:**

- Token counting uses `gpt-tokenizer` (already in the codebase for cost tracking)
- One skill per line: `- {name}: {description truncated to ~150 chars}`
- Coexistence with memory injection (Phase 5b): the total system prompt budget is split. Phase 5b memory gets priority (it's already shipped and load-bearing). Skills get remainder, bounded to max 2000 tokens. If more skills exist than fit, most-recently-used skills win (tracked in the dedicated `skill_usage` table via `skill-usage-queries.ts` — NOT in the workers table).
- `draft` skills are always excluded from `getPromptContext()` — they're not executable.

### The single-take demo script (ship criterion)

**Setup:** User has a failing Jest test visible on screen. Shell is in a monorepo. Research folder is pre-seeded with stub files to make timing deterministic (acknowledged: the research task is staged, not fully live, so the demo is reproducible and fits within the voice-only recording).

**Recording starts:**

1. User: _"Hey Neura, help me fix this test."_
2. Neura (voice): _"I don't have a skill for triaging failing tests yet. Want me to make one?"_
3. User: _"Yeah — read the failing test output on my screen, figure out which test is failing and why, and create a task with the repro command. Ask one clarifying question if you need it."_
4. Neura (voice): _"On it — creating skill `red-test-triage`."_
5. [Voice pause while worker runs, ~15-30s. Neura surfaces a single progress update: *"Still drafting the skill..."*]
6. Neura (voice): _"Skill created and loaded. Running it now."_
7. Neura (voice): _"The test `UserService › should hash password` is failing. Looks like bcrypt is receiving undefined. Is the environment variable `BCRYPT_SALT_ROUNDS` set in your test env?"_
8. User: _"No, forgot to add it."_
9. Neura (voice): _"Got it. Created a task: 'Add BCRYPT_SALT_ROUNDS=10 to .env.test, re-run UserService.test.ts'. Anything else?"_
10. User: _"Yeah, now do a research task. Find 5 articles on agent-based architectures, save them to ~/research/agents/, then upload them to our team wiki."_
11. Neura (voice): _"On it."_
12. [Staged research content — worker finds pre-seeded articles. Voice updates: *"Found 5 articles, saving them."*]
13. Neura (voice): _"I'm at the upload step but I don't have a skill for your team wiki. What URL should I post to?"_
14. User: _"https://wiki.team.com/api/pages. Use the NEURA_WIKI_TOKEN environment variable for auth."_
15. Neura (voice): _"Uploading now."_
16. Neura (voice): _"Done. All 5 articles are in the wiki. I also drafted a new skill `wiki-upload` from our conversation so I know how to do it next time. It's in draft mode — want me to activate it?"_
17. User: _"Yes please."_
18. Neura (voice): _"Activated. `wiki-upload` is ready."_
19. User: _"Show me what skills I have now."_
20. Neura (voice): _"You have two skills: `red-test-triage` and `wiki-upload`. Both are ready."_

**Recording ends.** The demo shows: skill creation from scratch, skill execution, mid-execution clarification, inline promotion from clarification (draft skill created during the same voice session), user promotion to ready, and a measurably more-capable system at the end. Entirely voice-driven. No cuts. No on-screen UI elements required.

**Staging acknowledgment:** The research task uses pre-seeded content to keep timing deterministic. This is documented in the README accompanying the demo video. A fully-live version of this demo is a Phase 7 polish goal once web search is stable and cost-acceptable.

## Open Questions

These do NOT block starting the design — they are decisions that can be made during implementation.

1. **Progressive disclosure strategy beyond Level-0.** The spec's recommendation is to inject a compact catalog and let the agent load full skill bodies on demand. **Decision (v2.1): the worker reads the file directly using pi's built-in `read` tool.** Each skill's `<location>` tag in the prompt catalog (emitted by pi's `formatSkillsForPrompt`) contains the absolute path to the SKILL.md file — the agent just reads it when relevant. No dedicated `load_skill_body` tool needed.

2. **Clarification queueing during mic-busy state.** The half-duplex mic suppression in `listen.ts` zeroes mic input while the speaker is active. If Neura interjects a clarification, the user's response starts at the end of Neura's sentence, so there's a brief window where mic chunks might be suppressed. Needs a manual test and possibly a small change to the suppression logic (e.g., resume mic immediately after Neura's last interject chunk).

3. **Skill naming collisions across locations.** If `./.neura/skills/foo/` and `~/.neura/skills/foo/` both exist, repo-local wins (per P4). Should we warn the user? Log silently? A warning on first load seems right but needs a UX decision.

4. **What happens to in-flight workers when the user ends the session** (Ctrl+C, close lid, etc)? Cancellation propagates per the Worker Cancellation section. But what if the user reconnects later — should they see a summary of what was cancelled? Yes — document this in the presence manager's reconnect flow during implementation.

## Success Criteria

The phase is **done** when all of the following are true:

1. **Ship criterion (P6):** A single unbroken screen recording shows the demo script above, from start to finish, with no cuts. Committed to `docs/phase6-demo.mp4` and linked from the README.

2. **Format compliance:** Skills created by Neura (via `create_skill` tool or clarification capture) load successfully in Claude Code via `claude --skills-dir ./.neura/skills/`. Verified end-to-end, not just by format inspection.

3. **Three-location loading:** Tests verify skill loading from all three locations with correct shadow resolution. Priority order is deterministic.

4. **Hot reload:** Adding, modifying, or deleting a skill file triggers registry update within 500ms. Verified by integration test using `chokidar` events.

5. **Clarification loop:** An end-to-end integration test exercises the full flow: worker calls the `request_clarification` pi custom tool → `clarification-bridge.ts` routes the question to a mock `grokSession.interject()` → mock user response returned via the transcript pipeline → worker resumes with answer → promotion session dispatched via `void dispatchPromotionWorker(...)` → draft skill file written. No mocked shortcuts in the bridge layer.

6. **Ambient progress:** A manual test verifies that a long-running worker surfaces progress updates via voice during both active and passive presence.

7. **Worker crash recovery (pause-then-restart path only):** Integration test starts a worker, steer-pauses it to `idle_partial`, simulates a core restart by disposing the session and clearing the in-memory runtime state, then reopens via `SessionManager.open(session_file)`, sends a resume prompt, and verifies the worker completes the remaining task steps. Mid-run crash recovery (killing the runtime while `running` or `blocked_clarifying`) is explicitly **out of scope** for Phase 6 — the startup sweep marks those rows terminal-`crashed` and surfaces them to the user for retry-from-scratch, not resume. This integration test mirrors Spike #4e's pattern.

8. **Permissions enforcement:** Integration test creates a skill declaring `allowed-tools: get_current_time` and verifies that if the worker tries to call `complete_task` (not in the allowlist), `session.agent.beforeToolCall` returns `{ block: true }` and the tool result is emitted as `tool_execution_end isError=true`. **Spike #4c already verified the enforcement mechanism end-to-end** — this integration test just freezes the behavior for regression.

9. **All existing tests pass.** Zero regressions on the 270+ test baseline.

10. **New code has tests.** ~80% coverage target on new modules (skills, workers, clarification bridge, pi-runtime, voice-fanout-bridge).

11. **Documentation:** `docs/phase6-os-core.md` exists with architecture diagram, skill format reference, worker lifecycle diagram, permissions model, and troubleshooting guide.

12. **Roadmap updated:** `docs/roadmap.md` reflects the fused Phase 6 (OS Core), the corrected Phase 7 sequencing (execution loop now explicitly a Phase 7 deliverable), and the updated Phase 8 SCION framing.

## Distribution Plan

Skills and workers ship as part of the existing `@neura/core` package — no new binary, no new download channel. Distribution is through the existing `neura update` flow (GitHub releases → core bundle download → atomic extraction).

New user experience:

- `neura install` creates `~/.neura/skills/` as part of its existing init and, if run inside a git repo, prompts whether to create `./.neura/skills/` as well
- `neura update` ships any new built-in skills bundled with the core release
- `neura chat` / `neura listen` can invoke `create_skill` and `run_skill` tools through the existing tool router
- Repo-local skills are opt-in per-repo
- `import_skill <local-path>` registers an explicit path (local filesystem only — URL and git fetch are Phase 9 marketplace scope)

CI/CD: existing semantic-release pipeline covers this. No new build steps required. `@mariozechner/pi-coding-agent` is a library dependency — it ships inside the Neura core bundle via the existing esbuild pipeline, so there is no external CLI installation step in the setup wizard. (The validated-fallback Approach A path would require a Claude Code CLI prerequisite if it ever gets activated, but that's out of scope for Phase 6 shipping.)

## Next Steps (v2 — Approach D)

All five spikes are complete (#1, #2, #4ab, #4c, #4d, #4e). The path from here is implementation-only. Total estimate: **M (2-3 weeks)** including demo polish.

### Phase 0 — spikes (DONE)

- ✅ Spike #1: Claude Code programmatic invocation (PASS — Approach A validated as fallback)
- ✅ Spike #2: Grok session.update mid-session (PASS — hot-load works, ~90ms latency)
- ✅ Spike #3: SCION feasibility (NOT READY — deferred to Phase 7+)
- ✅ Spike #4: pi-coding-agent SDK + steer (PASS — Approach D confirmed as primary)

### Phase 1 — foundation (2-3 days)

1. **Write types first** (0.5 day). `NeuraSkill` (extends pi's `Skill` with `allowedTools: string[]` and `metadata: Record<string, unknown>` — no Neura-specific top-level frontmatter types, just the nested fields the spec already defines), `WorkerTask`, `WorkerResult`, `WorkerCallbacks`, `WorkerStatus` in `packages/types/src/`. These shape everything downstream.

2. **Install pi-coding-agent and verify bundling** (0.5 day). Add `@mariozechner/pi-coding-agent` to `packages/core/package.json`. Run `scripts/bundle.ts` and verify esbuild tree-shakes cleanly. Fix any bundler issues. Smoke test `createAgentSession` inside Neura core's startup path (don't actually run it, just verify the import works).

3. **Build `skill-loader.ts` + `skill-registry.ts` + `skill-watcher.ts`** (1-2 days). Thin wrappers around pi's `loadSkills()`. Test with fixture skills loaded from all three locations (repo-local, global, explicit paths). Verify hot-reload via `chokidar`. Wire up the skill_usage MRU tracking via `skill-usage-queries.ts`.

4. **Create the two demo skills manually first as fixtures** (0.5 day). `red-test-triage` and `wiki-upload` as hand-written Agent Skills in `./.neura/skills/` of a test project. Verify they load via the `skill-loader.ts`. Use them to smoke-test the rest of the pipeline.

### Phase 2 — worker runtime (4-5 days)

5. **Build `neura-tools.ts`** (1 day). Adapt Neura's existing tools (vision, memory, task, presence, time) into pi `AgentTool<TSchema>` objects. Each tool becomes a TypeScript function whose `execute` calls the existing Neura tool handler. Keep it a thin wrapper — no behavior changes, just shape conversion.

6. **Build `worker-runtime.ts` + `pi-runtime.ts`** (2 days). Define the `WorkerRuntime` interface. Implement `PiRuntime` using `createAgentSession` with file-backed `SessionManager.create(cwd, sessionDir)` for new tasks and `SessionManager.open(session_file)` for resume. Persist `session.sessionFile` to the workers table after spawn. Wire up `customTools` with Neura's tools. Install the `beforeToolCall` hook on `session.agent` for `allowed-tools` enforcement. Subscribe to the event stream via `VoiceFanoutBridge.push` (synchronous). Test with a trivial task (call `describe_screen`, verify the event sequence), then test the full dispose/open/resume round-trip against a fixture task (should mirror Spike #4e in test form).

7. **Build `agent-worker.ts` + `worker-queries.ts`** (1 day). Orchestrator-side lifecycle: spawn via `PiRuntime.dispatch`, persist to `workers` table with the new `idle_partial` status for paused sessions, handle crash via pi's `stopReason` / rejected-promise pattern (NOT subprocess liveness — pi-runtime is in-process). Wire up `beforeToolCall` for the `allowed-tools` permissions check (taskType-aware: authoring bypasses, execution enforces). **This step depends on the spike work — the `beforeToolCall` hook and the pause/resume behavior are already empirically validated (Spike #4c), so this is implementation work, not design exploration.**

8. **Build `worker-cancellation.ts`** (0.5 day). Wire user "stop" voice intent to `pi.agent.abort()`. Test cancellation mid-tool-call (pi's signal should propagate to the tool's `execute` signal).

### Phase 3 — clarification + pause + voice integration (3-4 days)

9. **Build `clarification-bridge.ts`** (1 day). Register `request_clarification` as a Neura custom tool. Implement the voice-bridge flow (update status, interject, await next user turn, fire promotion worker, return answer). Test with a mock voice transcript pipeline.

10. **Build `promotion-templates.ts`** (0.5 day). Write the promotion prompt template per the "Promotion Worker Template" section above. Test that `dispatchPromotionWorker()` creates a valid draft SKILL.md.

11. **Add `interject()` method to `GrokVoiceProvider`** (1 day). Implement the contract from the "Grok provider patches" section (immediate vs queued, rate limiting with exemptions for clarification and completion, passive-presence wake flow). Write a unit test against a mock Grok WebSocket.

12. **Wire `presence-manager.ts` to worker progress events** (0.5 day). Active state → `grokSession.interject({ immediate: false })`. Passive state → queue and coalesce for next active transition.

13. **Implement user-initiated pause and resume** (1 day). Voice intent detection (keyword-based for v2). When "pause" is detected, call `session.prompt("PAUSE. Stop after the current tool call finishes. Do not start any more work. Say 'paused' and wait.", { streamingBehavior: "steer" })` — this is a steer because the agent is actively streaming. When "resume" is detected on the already-idle session, call `session.prompt("OK, continue the task you were working on.")` **WITHOUT** the `streamingBehavior: "steer"` option — the session is idle, there's nothing running to steer, this is a fresh turn on the same conversation. This matches the empirically-verified pattern from Spike #4c. Test with a long-running fake task similar to Spike #4b.

### Phase 4 — skill-tools + integration testing (2-3 days)

14. **Build `skill-tools.ts`** (1 day). `create_skill`, `run_skill`, `list_skills`, `import_skill`, `promote_skill` as Neura tool router entries. `run_skill` is async (returns worker_id immediately — decision from v1.2). `create_skill` dispatches a promotion session with taskType `write_skill`.

15. **Full integration test — skill creation → execution → clarification → promotion** (1-2 days). The end-to-end test validates the full loop without mocking the bridge layer. Can mock pi-ai at the provider level (pi has a `faux` provider for this exact purpose).

### Phase 5 — demo + polish (5-7 days)

16. **Rough demo take** (0.5 day). Record a rough walkthrough with manually-triggered flows to validate the theatrical flow makes sense before polishing.

17. **Polished single-take demo** (3-5 days of iteration). Voice in → capability gap → clarification → skill creation → hot-load → execution → promotion → done. One take. Acknowledge staged research content in the README if used.

18. **Update documentation and roadmap** (0.5 day). `docs/phase6-os-core.md`, README link, roadmap restructure. Remove the Phase 5a execution loop mistake from the roadmap and move it to Phase 7. Note the SCION status (not ready, Phase 7+). Credit Mario Zechner / pi-mono prominently in the release notes.

19. **Phase 6 release** (0.5 day). Semantic release, CHANGELOG, demo video link, blog post (strongly recommended — this is a compelling narrative).

### Rough timeline

Adding phase estimates:

- Phase 1: 2-3 days
- Phase 2: 4-5 days
- Phase 3: 3-4 days
- Phase 4: 2-3 days
- Phase 5: 5-7 days

Total: **16-22 days of focused work ≈ 2-3 weeks** assuming no major blockers.

## What I noticed about how you think

Four observations from this session. These are for future-you (and future contributors reading this doc) to understand the reasoning behind decisions that might otherwise look arbitrary.

- **You turned a feature list into an operating system architecture, unprompted.** When I asked about the 10x version, you didn't give me a bigger feature. You gave me "Neura is an OS for autonomous work. Voice is the shell. Workers are processes. Skills are shared libraries." That's a structural reframe, not an incremental one. It gave every future phase a place to live and a reason to exist. Keep that instinct.

- **You added the clarification capture loop as a throwaway example.** You were answering a question about storage flexibility and casually described a worker→orchestrator→user→worker flow with proto-skill promotion, and it turned out to be the single most novel architectural primitive in the whole design. Every competitor learns from completed tasks. You're learning from gaps. Your intuitions about real workflows are generating real architectural insight. Trust the examples more than the abstractions.

- **You pushed back on the "one skill-writer worker" framing and replaced it with "one agnostic worker that absorbs skills on demand."** I had the two-worker split because it felt safer. You saw it was more elegant to have one. That's the Unix instinct — one process type, specialization via prompts. Elegance is not decoration. It's what lets the system keep simple rules at scale.

- **When Codex challenged P4, you accepted the challenge and then improved the answer beyond what Codex suggested.** Codex said "add a repo-local overlay." You said "three locations, including arbitrary paths." The three-location model is better than either my original or Codex's fix. This happens when a builder engages with critique as information rather than as correction.

## Reviewer Concerns

_Spec review round 1 surfaced the following material issues, all incorporated into the revision above:_

- Phase 5a execution loop hallucination — resolved by revising P8 to inline promotion (Option A).
- No permissions/sandbox model — added "Permissions & Trust Tiers" section.
- Wire format fragility (sentinel strings on stdout) — replaced with MCP tool calls via Neura MCP server.
- Effort estimate inconsistency — revised Approach A to M (3-4 weeks).
- Unverified Claude Code and Grok assumptions — made both into mandatory blocking spikes with explicit fallback.
- Worker crash recovery not in spec — moved from open questions into the spec with a concrete strategy.
- Promotion worker template undefined — added as a concrete template in `promotion-templates.ts`.
- Demo script referenced on-screen UI in a voice-only architecture — removed.
- Store file paths nested under non-existent `queries/` subdir — flattened to match repo layout.
- `grokSession.interject()` referenced but doesn't exist — added as a new method on `GrokVoiceProvider` with an explicit contract.
- `neura_source` speced as closed enum — changed to open non-empty string.

_Round 2 review verified all 19 round 1 fixes and surfaced 10 new internal contradictions introduced by the revision. All 10 were addressed in a targeted second pass:_

- Duplicate `worker-store.ts` / `worker-queries.ts` — removed `worker-store.ts`, consolidated into `worker-queries.ts` under `stores/`.
- `worker_store.last_used_at` referenced a non-existent column — added a dedicated `skill_usage` table with `skill-usage-queries.ts` for MRU tracking.
- Heartbeat mechanism undefined — clarified as process-level liveness (Node `'exit'`/`'error'` events) + MCP channel liveness (transport hooks). No semantic heartbeat tool. Progress staleness is a soft signal only.
- `request_clarification` blocking MCP tool call feasibility — added as a second script in Spike #1 (`sleep_then_echo` test with 90-second handler). Explicit fallback to polling pattern if the blocking pattern is not supported.
- Promotion worker permissions — added explicit rule that skill-authoring workers bypass `neura_tools_used` enforcement. The context is set at dispatch time.
- Two workers concurrent during promotion — promoted from Open Question to spec. Concurrency ceiling is exactly 2 during promotion, 1 otherwise.
- `run_skill` sync vs async — closed as async. Returns worker_id immediately, streams progress via `interject()`. This was implicit in the demo script but now explicit in the spec.
- `version` frontmatter field — spec'd as optional with default behavior on first promotion.
- `blocked_clarifying` status written to worker store — added steps 3 and 6 in the clarification flow to update status before/after the user answer.
- Spike #1 pass criteria — extended to cover long-blocking tool handlers.

_Round 3 review verified all 10 round-2 fixes as FIXED. Final verdict: APPROVED (quality 9/10). Six tertiary non-blocker concerns to address during implementation (not architectural — polish and self-documentation):_

1. **`skill_usage` table schema completeness** — when writing the migration, specify primary key (`skill_name`) and lazy-populate strategy (row created on first `run_skill` dispatch, not on skill load).
2. **`interject()` rate limit vs clarification flow** — the 10-second spam guard may fire during legitimate back-to-back clarification + completion interjects. Either exempt `clarification_response` and `worker_completion` urgency tags from rate limiting, or document the limit as soft.
3. **`skill-permissions.ts` vs `mcp-tool-adapter.ts` ownership split** — policy (allowlist data structure + is-allowed predicate) lives in `skill-permissions.ts`; enforcement (calling into the predicate at MCP tool invocation time) lives in `mcp-tool-adapter.ts`. Documented here to settle implementation ownership.
4. **Crash recovery summary should suppress internal workers** — the "X unfinished tasks" message on reconnect should count only user-facing tasks (parent workers), not internal promotion children. Add a `is_internal: boolean` field to `worker-queries.ts` if needed.
5. **Promotion Worker Template self-documentation** — add an inline comment to `promotion-templates.ts` clarifying that `file_write` / `file_edit` / `file_read` are Claude Code built-in tools, not Neura MCP tools, and do not require a `neura_tools_used` declaration for authoring workers.
6. **Spike #1 time budget** — the Next Steps section should reflect 1.5 days for Spike #1 (not 1 day) to account for the added Script 2 long-blocking test.

None of these are architectural issues. They are documentation polish and implementation-time decisions. The document is ready for implementation to begin.

---

### v2 revision — Spike #3 (SCION) + Spike #4 (pi-coding-agent)

After the three rounds of spec review above, two additional spikes were run:

**Spike #3 — SCION feasibility.** The user pointed at Google Cloud's SCION (opened April 2026) as a potential worker runtime because it natively supports agent `start` / `stop` / `resume` / `attach` / `message` lifecycle primitives. SCION was spiked on macOS with the following findings:

- ❌ No tagged releases on GitHub
- ⚠️ Requires git 2.47+ (system had Apple Git 2.39; fixed via `brew install git`)
- ❌ **CRITICAL: Requires building and pushing container images to a registry before any agent can start.** No publicly hosted SCION images exist. Every user must fork the SCION repo, build images locally, push to ghcr.io (or equivalent), and configure SCION to point at their registry. Complete DX disqualification for a tool that currently ships via `npm install`.
- ⚠️ Apple `container` runtime has networking limitations on macOS 15 Sequoia (no container-to-container communication)
- ❓ Claude Code harness support level unverified (blocked by #3)

**SCION verdict:** not ready for Phase 6. Revisit in Phase 7+ as an optional advanced runtime once it ships public images and stabilizes. Full writeup in `tools/spikes/phase6/SCION-FINDINGS.md`.

**Spike #4 — pi-coding-agent feasibility.** In response to Spike #3's failure, the user pointed at `@mariozechner/pi-coding-agent` (Mario Zechner / badlogic, MIT licensed, 245 releases). Spike #4 ran two scripts:

- ✅ **Spike #4a — SDK embedding + custom tool + event stream.** `createAgentSession()` returned a working session in 21ms. Custom tool (`neura_test_ping`) registered via `customTools` and invoked correctly. 9 distinct event types streamed via `subscribe()`. xAI grok-4-fast worked as the worker model. End-to-end: 2.7 seconds (4x faster than Spike #1's Claude Code wrapper equivalent).
- ✅ **Spike #4b — `streamingBehavior: "steer"` mid-execution interrupt.** Agent told to upload 3 documents (each taking 6 seconds). After upload #1 started, a steer message was injected via `session.prompt("STOP, wait", { streamingBehavior: "steer" })`. Upload #1 completed cleanly at the 6-second mark (in-flight work not corrupted). Agent did NOT start uploads #2 or #3. Final assistant message: "paused". **The user-initiated pause scenario (CMS upload phone-call case) is handled natively with one line of code.**

Additionally, 1859 lines of pi-agent-core source and 508 lines of pi's skills.ts were reviewed. Key findings:

- Pi implements the Agent Skills spec verbatim (same format as Claude Code, Cursor, Codex)
- Pi's `loadSkills()` supports all three P4 storage locations with first-hit-wins collision handling
- Pi's `beforeToolCall` / `afterToolCall` hooks are exactly the permissions enforcement point Phase 6 needs
- Pi's `disable-model-invocation` frontmatter field is a cleaner primitive than the original v1 `neura_status: draft | ready` distinction
- Pi ships both SDK mode (in-process) and RPC mode (subprocess) — `WorkerRuntime` interface can swap between them if stability issues emerge
- Pi-agent-core has only **one** transitive dependency and is 1859 lines across 5 files — forkable in a weekend if upstream ever stops maintenance

**Spike #4 verdict:** Approach D (pi-coding-agent SDK) becomes the primary Phase 6 runtime. Approach A (Claude Code wrapper, validated by Spikes #1 and #2) stays as a validated fallback behind the `WorkerRuntime` interface. Full writeup in `tools/spikes/phase6/PI-FINDINGS.md`.

### v2 changes applied to this doc

Based on Spike #4:

1. **Approach D added as the recommended approach.** Approach A moved to "validated fallback" status.
2. **Architecture diagram rewritten** to show pi's AgentSession, customTools, event stream, and the `beforeToolCall` hook.
3. **Files to create slimmed down** — deleted `skill-parser.ts`, `skill-locations.ts`, `skill-validator.ts`, `skill-permissions.ts`, `neura-mcp-server.ts`, `mcp-tool-adapter.ts`. Added `pi-runtime.ts`, `neura-tools.ts`. Kept the `WorkerRuntime` interface boundary so fallback remains possible.
4. **Dependencies table updated** — removed `@modelcontextprotocol/sdk` and `gray-matter`, added `@mariozechner/pi-coding-agent`.
5. **Permissions & Trust Tiers section rewritten** — `disable-model-invocation` replaces `neura_status: draft | ready`. Enforcement moves from MCP adapter middleware to pi's `beforeToolCall` hook.
6. **Clarification protocol rewritten** — `request_clarification` is now a pi custom tool (in-process), not an MCP tool. The blocking-MCP-handler concern from Spike #1 doesn't apply here because there's no IPC boundary.
7. **New "User-initiated pause and resume" section added** — uses `session.prompt(..., { streamingBehavior: "steer" })` as the one-line primitive. The Option C checkpoint dance from the previous conversation turn is no longer needed.
8. **Skill format updated** — includes `disable-model-invocation: false` as the active-skill example. `neura_status` field removed. Validation rules updated to reflect that pi enforces most checks and Neura adds a thin wrapper for Neura-specific fields.
9. **Promotion Worker Template updated** — uses pi's built-in `read`, `write`, `edit` tool names instead of Claude Code's. References the Anthropic Agent Skills GitHub repo and agentskills.io. Explicitly documents the taskType-based permission bypass.
10. **Next Steps section restructured** — all spikes marked DONE (as of v2.1: #1, #2, #4ab, #4c, #4d; v2.2 adds #4e). Remaining work is organized into 5 phases (foundation, worker runtime, clarification/pause/voice, skill-tools/testing, demo/polish) totaling 16-22 days ≈ 2-3 weeks.

### v2 concerns to track during implementation

1. **Single-author dependency risk** (pi-mono maintained by Mario Zechner). Mitigation: pi-agent-core is forkable in a weekend; RPC mode (`runRpcMode`) provides subprocess isolation if SDK mode hits stability issues.
2. **Bundleability of `@mariozechner/pi-coding-agent`** with Neura's current `scripts/bundle.ts` pipeline. Must verify esbuild tree-shakes cleanly in step 2 of the Next Steps phase 1.
3. **Pi's `faux` provider for integration tests** — referenced in pi's source but not yet exercised in this spike. Verify during integration test implementation (step 15).
4. **Text rendering artifacts** — Spike #4 observed Grok emits tool-call JSON in the assistant text stream (`"{"docName":"doc-alpha.pdf"}paused"`). Neura's voice bridge may need a regex to strip these before sending to Grok voice. Implementation-time polish.
5. **pi vs neura skill path precedence** — v2.1 RESOLVED by Spike #4d: pass Neura's paths via the `skillPaths: []` option with `includeDefaults: false` to use ONLY Neura paths, or `includeDefaults: true` to also load pi's default locations. Default v2.1 config is `includeDefaults: false` (Neura uses its own paths exclusively; users running pi separately keep their pi skills untouched).

---

### v2.1 revision (Codex cold read of v2 + additional spikes)

Codex reviewed v2 and returned **REVISE verdict at 6/10**. Five dimensions of feedback, all incorporated:

**Fixed in v2.1:**

1. **Permissions model contradicted the portability story** — v2 had `neura_tools_used` as mandatory while claiming "skills written anywhere run in Neura." The field was the fork. v2.1 drops `neura_tools_used` entirely in favor of the standard Agent Skills spec `allowed-tools` field, enforced via pi's `beforeToolCall` hook. Spike #4c verified enforcement end-to-end: 5 hook invocations, 1 block on `secret_delete`, agent observed and continued gracefully. Neura-specific metadata moved under the spec's `metadata:` nested field. **Zero Neura-invented top-level frontmatter fields in v2.1.**

2. **Pause/resume was overclaimed** — v2 described "session sits paused for 30 minutes waiting for steer-resume" which does not exist in pi's model. Spike #4c proved the correct model: pause is a steer → `agent_end` → session becomes truly idle → conversation transcript preserved by SessionManager → resume is a fresh `session.prompt()` call (NOT a steer). Ran with a 20-second idle period, agent correctly resumed and completed the remaining 2 of 3 uploads without re-uploading the first one. The "User-initiated pause and resume" section was rewritten to match observed behavior.

3. **Stale MCP/subprocess references** throughout live spec sections (constraints, P8, crash recovery, architecture diagram, types section, promotion worker template, success criteria, Next Steps). All swept and rewritten for Approach D's in-process architecture. Historical references in Reviewer Concerns sections and archived correction notes are preserved as revision history.

4. **Tool name mismatches** — v2 used illustrative names (`vision.get_screen`, `task.create`, `time.current_time`, `memory.recall`) that don't match the actual Neura tool registry. v2.1 corrected to real names from `packages/core/src/tools/`: `describe_screen`, `create_task`, `get_current_time`, `recall_memory`, etc.

5. **Listener performance risk** — Codex flagged that pi's `Agent.subscribe()` awaits listener promises serially. If the voice-bridge listener awaits a 500ms Grok interject per delta, a 50-delta response stalls the agent loop by 25 seconds. v2.1 adds a new file (`voice-fanout-bridge.ts`, ~150 lines) with a synchronous `push()` interface + async drain loop that coalesces text deltas within a 250ms budget window. Pi's agent loop is never blocked by voice round-trips.

6. **Session persistence gap** — v2 recommended `SessionManager.inMemory()`. A core crash during a paused idle period would lose the conversation transcript. v2.1 switches the recommendation to `SessionManager.create(cwd, sessionDir)` — pi's file-backed session manager. Resume across a core restart is now survivable. Zero additional code (already a constructor option).

7. **Crash recovery model was subprocess-oriented** — v2 talked about `child_process` exit events and MCP channel liveness, neither of which exist in Approach D's in-process runtime. v2.1 rewrote the crash recovery section to reflect the actual failure modes: tool execute throws (pi catches as error event), LLM API failure (pi retries + error event), unhandled listener rejection (wrapped in try/catch + `process.on('unhandledRejection')`), OOM/native crash (recover at next startup via file-backed session files).

8. **Worker crash recovery + Next Steps ordering dependency** — Codex flagged that the worker crash model should be resolved before `agent-worker.ts` since the plan assumed subprocess-style liveness for an in-process runtime. v2.1 addresses this: the `agent-worker.ts` description now explicitly says "crash detection via pi's `stopReason` / rejected-promise pattern (NOT subprocess liveness)" and Next Steps phase 2 step 7 includes a note that the design is pre-validated.

9. **Skill loader sizing** — pi's `Skill` type does not expose `allowed-tools` or `metadata.*` frontmatter fields (verified by Spike #4d). v2.1 notes the loader needs to re-parse SKILL.md files (~130 lines for `skill-loader.ts` covering wrap + diagnostics, plus ~60 lines for `neura-skill.ts` for the extended type).

10. **"Skills written anywhere run in Neura" claim** — v2.1 makes this technically true because every top-level field is Agent Skills spec standard. A skill from Claude Code with `allowed-tools: edit bash` just works in Neura (Neura enforces the field that Claude Code documents but doesn't enforce). A skill from Neura with `allowed-tools: describe_screen create_task` works in Claude Code (fields Claude Code doesn't know about get silently ignored per the spec's lenient validation).

**What Codex said is the "one thing the author is too attached to":**

> "You are too attached to the 'open standard, no fork, skills written anywhere run in Neura' narrative while simultaneously making `neura_tools_used` required. Pick one. As written, the permissions model IS the fork."

**v2.1 picked the portability story** and reshaped the permissions model to use standard fields. Codex was right. Dropping the custom field in favor of `allowed-tools` made the doc simpler AND more portable.

**What Codex said would make it lose confidence during implementation:**

> "If it turns out the permissions model cannot preserve third-party Agent Skills compatibility without making execution unsafe, the doc's core product story collapses."

Spike #4c verified that the permissions model works with the standard `allowed-tools` field AND preserves compatibility. The concern is resolved empirically, not just on paper.

---

### v2.2 revision (Codex round 2 cold read + Spike #4e)

Codex reviewed v2.1 and returned **REVISE verdict at 7/10** (up from 6/10 on v2, so the trend is right). Codex flagged one HIGH-severity issue, three MEDIUM, and two LOW. All incorporated:

**Fixed in v2.2:**

1. **[HIGH] Restart-safe resume was naming the wrong pi API.** v2.1 said: "Neura reads them via `SessionManager.create(cwd, sessionDir)` with the original `sessionId`, then sends a fresh prompt." That sentence is wrong — `SessionManager.create()` always starts a new session file, never reopens an existing one. The `sessionId` parameter doesn't reopen anything. The correct reopen API is `SessionManager.open(sessionFile)` (pi's session-manager.d.ts:303). And because `open()` is path-addressed, Neura must persist the **full filesystem path** (`session.sessionFile`), not just the sessionId.

   **Spike #4e** ran the full round-trip to verify the fix: create file-backed session → run 3-upload task → pause → `session.dispose()` → `SessionManager.open(sessionFile, sessionDir)` → new `createAgentSession({ sessionManager })` → resume prompt → 2 remaining uploads completed in the reopened session. Total 22.1s, exactly 3 upload calls (no duplication of the already-completed upload), same `sessionId` across both session objects. Verified end-to-end.

   Changes: "Session persistence" section rewritten with the correct API and code sketch, workers table schema adds both `session_file TEXT NULL` (the load-bearing one) and `session_id TEXT NULL` (stored for cross-reference). `pi-runtime.ts` description now explicitly covers both the spawn path (`create`) and the resume path (`open`). Phase 2 step 6 adds a test that mirrors Spike #4e.

2. **[MEDIUM] VoiceFanoutBridge had two real bugs in the sketch.** (a) The 250ms coalescing window never actually waited for future deltas. The sketch set `cutoff = Date.now() + 250` inside the drain loop, but the inner `while` only consumed events already queued at entry — it never yielded the event loop for new events to arrive. Without an explicit `await`, the "window" collapsed to zero. Fix: `await sleep(coalesceBudgetMs)` before draining the text batch, so new deltas from synchronous `push()` calls accumulate during the wait. (b) `void this.drain()` made any drain error an unhandled rejection. Fix: `.catch()` on the fire-and-forget, logs the error, releases the `draining` guard so the next push can restart the loop. Both fixes landed in the Voice listener async fanout sketch.

3. **[MEDIUM] Skill-path priority order was reversed in the sketch.** P4 says `./.neura/skills/` is highest priority, then `~/.neura/skills/`, then explicit config paths. The v2.1 `skill-loader.ts` sketch listed them as `['~/.neura/skills', './.neura/skills', ...explicitPaths]` — global first, which contradicts the premise. Fix: corrected the order to `['./.neura/skills', '~/.neura/skills', ...explicitPaths]`.

4. **[MEDIUM] `idle_partial` was listed in the `WorkerStatus` type but missing from the workers table status enum.** The types section had it; the `worker-queries.ts` column description didn't. Fix: added `idle_partial` to the status enum in the `worker-queries.ts` description and clarified the recovery sweep treats it as a resumable state.

5. **[LOW] P1 and P7 still referenced top-level `neura_*` fields.** P1 said "Neura-specific metadata goes in namespaced frontmatter fields (`neura_*`) only" as if they were top-level, contradicting v2.1's "zero Neura-invented top-level frontmatter fields" claim. P7 said "skills have a `neura_source` field" as if it were top-level. Fix: both corrected to point at the nested `metadata.neura_source` key.

6. **[LOW] Skill loader line-count was inconsistent.** v2.1 said "~50 lines instead of 30" in one place and "~130 lines, revised from v2" in another. The reality (wrap + re-parse + diagnostic surfacing + NeuraSkill type adapter) is ~130 lines in `skill-loader.ts` plus ~60 lines in `neura-skill.ts`. Standardized both references.

**What Codex said would still concern it:**

> "Restart-safe resume is the one architectural claim that, if wrong, undermines the whole durability story. The doc says the right thing but points at the wrong API. Verify with a spike that actually closes a session and reopens from disk, not just a pause on a live session."

That's exactly what Spike #4e did. The fix is now empirically validated, not paper.

**Remaining concerns (deferred to implementation):**

- VoiceFanoutBridge coalesce window is a heuristic; real-world tuning may show 250ms is too long (hurts perceived voice latency) or too short (not enough coalescing). Plan to expose as a config knob.
- Tool registry evolution across resume is an open question: if Neura renames `describe_screen` between session create and reopen, saved tool_call entries in the JSONL won't match. Phase 6 ships with the constraint "don't rename tools that appear in active sessions." Phase 7+ may need a tool-name migration layer.
- Pi's `faux` provider still hasn't been exercised in integration tests (v2 concern #3). Remains open.

## Appendix: Sources

Landscape findings from the Phase 2.75 search that shaped this design:

- [Anthropic Agent Skills engineering post](https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills)
- [anthropics/skills GitHub repository](https://github.com/anthropics/skills) — canonical format source
- [Hermes Agent (NousResearch)](https://github.com/nousresearch/hermes-agent)
- [Hermes Agent Self-Evolution (DSPy + GEPA)](https://github.com/NousResearch/hermes-agent-self-evolution)
- [Self-Evolving Agents open-source roundup 2026](https://evoailabs.medium.com/self-evolving-agents-open-source-projects-redefining-ai-in-2026-be2c60513e97)
- [SCION (Google Cloud)](https://github.com/GoogleCloudPlatform/scion)
- [Scion concepts documentation](https://googlecloudplatform.github.io/scion/concepts/)
- [Top agentic AI frameworks 2026](https://www.alphamatch.ai/blog/top-agentic-ai-frameworks-2026)

### Approach D sources (added in v2)

- [pi-mono monorepo](https://github.com/badlogic/pi-mono) — Mario Zechner's toolkit
- [pi-agent-core package](https://github.com/badlogic/pi-mono/tree/main/packages/agent) — the runtime we embed
- [pi-coding-agent package](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent) — the SDK entry point (`createAgentSession`)
- [Mario Zechner (@badlogic)](https://github.com/badlogic) — credit in README + Phase 6 release notes

### Spike writeups (in-repo)

- `tools/spikes/phase6/FINDINGS.md` — Spikes #1 (Claude Code programmatic invocation) and #2 (Grok session.update)
- `tools/spikes/phase6/SCION-FINDINGS.md` — Spike #3 (SCION not ready)
- `tools/spikes/phase6/PI-FINDINGS.md` — Spike #4 (4a + 4b, pi-coding-agent PASS, Approach D adopted)
- `tools/spikes/phase6/pi-test/spike4c-resume.mjs` — Spike #4c (pause + resume + beforeToolCall, NEW in v2.1)
- `tools/spikes/phase6/pi-test/spike4d-skill-paths.mjs` — Spike #4d (Neura skill path loading, NEW in v2.1)
- `tools/spikes/phase6/pi-test/spike4e-restart.mjs` — Spike #4e (restart-safe session resume via `SessionManager.open()`, NEW in v2.2)
- `tools/spikes/phase6/pi-test/fixture-skills/.neura/skills/` — fixture skills used by Spike #4d (`hello-world` and `draft-skill`)
