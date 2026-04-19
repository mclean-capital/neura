/**
 * Phase 6 — PiRuntime integration test (faux provider)
 *
 * End-to-end validation that the pi-backed worker runtime actually
 * drives a full dispatch → completion cycle through the real
 * pi-coding-agent SDK. Everything below the PiRuntime boundary is
 * live: SessionManager writes a JSONL to disk, createAgentSession
 * registers customTools on a real pi Agent, subscribe() fires real
 * AgentEvents, the VoiceFanoutBridge drains them into an interjector,
 * and AgentWorker mirrors the terminal result into PGlite.
 *
 * Everything ABOVE the LLM boundary is stubbed via pi-ai's faux
 * provider: deterministic scripted responses, zero network, no auth
 * required. This is exactly the "integration test via pi's faux
 * provider" called out as the Phase 6 minimum-viable-ship polish
 * item in docs/phase6-os-core.md.
 *
 * What these tests prove that the unit tests don't:
 *
 *   1. PiRuntime.dispatch actually spawns a pi AgentSession that
 *      terminates with an `agent_end` event the runtime observes.
 *   2. VoiceFanoutBridge actually receives subscribed events from
 *      a real pi subscribe() call (not a mocked stream).
 *   3. AgentWorker's onComplete callback actually writes the
 *      terminal row to the workers table (real PGlite, not a mock).
 *   4. The "stop" → completed and "error" → failed mappings hold
 *      against a real pi assistant message, not a hand-constructed
 *      `AgentEvent` shape.
 *
 * Tests are deliberately narrow — they don't re-exercise the clarification
 * bridge (covered by its own unit tests), or the skill registry MRU ranking
 * (covered by its own tests). The integration test's job is to prove the
 * seams between those components hold when pi is real.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
import {
  fauxAssistantMessage,
  registerFauxProvider,
  type FauxProviderRegistration,
} from '@mariozechner/pi-ai';
import { AuthStorage } from '@mariozechner/pi-coding-agent';
import type { NeuraSkill, WorkerResult, WorkerStatus, WorkerTask } from '@neura/types';
import { runMigrations } from '../stores/migrations.js';
import { getWorker } from '../stores/worker-queries.js';
import { SkillRegistry } from '../skills/skill-registry.js';
import { AgentWorker } from './agent-worker.js';
import { buildNeuraTools, type NeuraAgentTool } from './neura-tools.js';
import { PiRuntime } from './pi-runtime.js';
import { VoiceFanoutBridge, type VoiceInterjector } from './voice-fanout-bridge.js';

// ────────────────────────────────────────────────────────────────────
// Test harness
// ────────────────────────────────────────────────────────────────────

interface InterjectCall {
  message: string;
  immediate: boolean;
  bypassRateLimit: boolean | undefined;
}

function makeCapturingInterjector(): {
  interjector: VoiceInterjector;
  calls: InterjectCall[];
} {
  const calls: InterjectCall[] = [];
  const interjector: VoiceInterjector = {
    interject: (message, options) => {
      calls.push({
        message,
        immediate: options.immediate,
        bypassRateLimit: options.bypassRateLimit,
      });
      return Promise.resolve();
    },
  };
  return { interjector, calls };
}

/**
 * A single-skill registry with one reference-doc skill loaded. Post-Wave 1
 * the `allowed-tools` enforcement is gone, so the skill's job here is
 * purely to populate the registry for prompt-construction assertions.
 */
function makeRegistryForIntegration(): SkillRegistry {
  const registry = new SkillRegistry();
  const skill: NeuraSkill = {
    name: 'integration-test-skill',
    description: 'A skill used by the pi-runtime integration tests.',
    filePath: '/virtual/integration-test-skill/SKILL.md',
    baseDir: '/virtual/integration-test-skill',
    location: 'explicit',
    disableModelInvocation: false,
    allowedTools: ['get_current_time', 'recall_memory', 'remember_fact'],
    hasExplicitAllowedTools: true,
    metadata: {},
    body: 'Integration skill body.',
  };
  registry.replaceAll([skill]);
  return registry;
}

/**
 * Wait for async event draining. The voice fanout bridge sleeps for
 * `coalesceBudgetMs` during text delta coalescing, so we need to let
 * that resolve before asserting on captured interjector calls.
 */
function waitForDrain(ms = 80): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface Harness {
  db: PGlite;
  tmpRoot: string;
  faux: FauxProviderRegistration;
  registry: SkillRegistry;
  bridge: VoiceFanoutBridge;
  interjectorCalls: InterjectCall[];
  runtime: PiRuntime;
  worker: AgentWorker;
}

async function buildHarness(): Promise<Harness> {
  // PGlite — real migrations, real workers table.
  const db = await PGlite.create('memory://', { extensions: { vector } });
  await runMigrations(db);

  // tmp dirs for cwd / agentDir / sessionDir. Keep them under a single
  // root so cleanup is a single rmSync.
  const tmpRoot = mkdtempSync(join(tmpdir(), 'neura-pi-integration-'));
  const cwd = join(tmpRoot, 'cwd');
  const agentDir = join(tmpRoot, 'agent');
  const sessionDir = join(agentDir, 'sessions');

  // Faux provider — registers a fresh `api:faux-*` id in the pi-ai
  // registry so each test is isolated. The model we hand to pi-runtime
  // points at that api; pi resolves it via the registry at stream time.
  const faux = registerFauxProvider({});

  // Pi's createAgentSession resolves an API key for the model's
  // provider via AuthStorage. The faux provider is fake, so we seed
  // an in-memory AuthStorage with a dummy API key under the faux
  // provider's id. Without this, pi throws "No API key found for
  // faux." before ever invoking the registered stream function.
  const authStorage = AuthStorage.inMemory({
    [faux.models[0].provider]: { type: 'api_key', key: 'faux-dummy-key' },
  });

  const registry = makeRegistryForIntegration();
  const { interjector, calls: interjectorCalls } = makeCapturingInterjector();
  const bridge = new VoiceFanoutBridge({
    interjector,
    coalesceBudgetMs: 10,
  });

  const runtime = new PiRuntime({
    model: faux.getModel(),
    thinkingLevel: 'off',
    cwd,
    agentDir,
    sessionDir,
    buildTools: ({ workerId: _workerId }): NeuraAgentTool[] =>
      buildNeuraTools({
        // Vision isn't used by workers; return a stub so typing is happy.
        queryWatcher: () => Promise.resolve('vision disabled in integration tests'),
        memoryTools: {
          storeFact: () => Promise.resolve('fact-1'),
          recall: () => Promise.resolve([]),
          storePreference: () => Promise.resolve(undefined),
          invalidateFact: () => Promise.resolve('fact-1'),
          getTimeline: () => Promise.resolve([]),
          getMemoryStats: () =>
            Promise.resolve({
              totalFacts: 0,
              activeFacts: 0,
              expiredFacts: 0,
              topCategories: {},
              totalEntities: 0,
              totalRelationships: 0,
              oldestFact: null,
              newestFact: null,
              totalTranscriptsIndexed: 0,
              storageEstimate: '0 KB',
            }),
        },
        taskTools: {
          createTask: () => Promise.resolve('task-1'),
          listTasks: () => Promise.resolve([]),
          getTask: () => Promise.resolve(null),
          updateTask: () => Promise.resolve(null),
          deleteTask: () => Promise.resolve(true),
        },
      }),
    voiceFanoutBridge: bridge,
    skillRegistry: registry,
    authStorage,
  });

  const worker = new AgentWorker({ db, runtime });

  return {
    db,
    tmpRoot,
    faux,
    registry,
    bridge,
    interjectorCalls,
    runtime,
    worker,
  };
}

async function tearDownHarness(h: Harness): Promise<void> {
  try {
    h.faux.unregister();
  } catch {
    // best-effort
  }
  try {
    await h.db.close();
  } catch {
    // best-effort
  }
  try {
    rmSync(h.tmpRoot, { recursive: true, force: true });
  } catch {
    // best-effort
  }
}

// ────────────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────────────

const integrationTask = (): WorkerTask => ({
  taskType: 'execute_skill',
  skillName: 'integration-test-skill',
  description: 'Say hi and nothing else.',
});

describe('PiRuntime integration (faux provider)', () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await buildHarness();
  });

  afterEach(async () => {
    await tearDownHarness(harness);
  });

  it('happy path: dispatches a task, completes with stopReason stop, persists completed row', async () => {
    const { faux, worker, interjectorCalls } = harness;

    // Script a single assistant reply that terminates on its own.
    // No tool call, no follow-up turn — straight to completion.
    faux.setResponses([
      fauxAssistantMessage('Hi from the integration test.', { stopReason: 'stop' }),
    ]);

    const statusEvents: WorkerStatus[] = [];
    const handle = await worker.dispatch(integrationTask(), {
      onStatusChange: (s) => statusEvents.push(s),
    });

    const result = await handle.done;
    // Give the bridge's async drain + the callbacks' async PGlite
    // writes a moment to settle before asserting. The drain loop
    // sleeps for coalesceBudgetMs (10ms) between text deltas and
    // the DB writes are queued with `void`.
    await waitForDrain();

    expect(result.status).toBe('completed');
    expect(statusEvents).toContain('completed');

    // Workers row matches.
    const row = await getWorker(harness.db, handle.workerId);
    expect(row?.status).toBe('completed');
    expect(row?.sessionId).toBe(handle.sessionId);
    expect(row?.sessionFile).toBe(handle.sessionFile);

    // Voice fanout bridge received the real pi event stream. We
    // don't assert on the exact delta count — pi's token chunking is
    // nondeterministic — but the coalesced text should contain the
    // assistant phrase, AND the bridge's agent_end handler should
    // have spoken a "Done." affordance (stopReason stop, no pending
    // pause).
    const spokenText = interjectorCalls.map((c) => c.message).join('');
    expect(spokenText).toContain('Hi from the integration test');
    expect(
      interjectorCalls.some((c) => c.message === 'Done.'),
      `expected a "Done." call, got: ${interjectorCalls.map((c) => JSON.stringify(c)).join(' | ')}`
    ).toBe(true);
  });

  it('error path: assistant stopReason error maps to failed, interjector stays silent', async () => {
    const { faux, worker, interjectorCalls } = harness;

    // Script an error response. Faux emits an `error` event and pi's
    // agent loop maps that into an assistant message with
    // stopReason "error" + errorMessage, then emits `agent_end`.
    faux.setResponses([
      fauxAssistantMessage('', {
        stopReason: 'error',
        errorMessage: 'simulated provider outage',
      }),
    ]);

    const handle = await worker.dispatch(integrationTask());
    const result: WorkerResult = await handle.done;
    await waitForDrain();

    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      // reason is "error" from the extractor; detail is whatever pi
      // surfaces (we don't over-specify the string).
      expect(result.error?.reason).toBe('error');
    }

    const row = await getWorker(harness.db, handle.workerId);
    expect(row?.status).toBe('failed');
    expect(row?.error?.reason).toBe('error');

    // Bridge should NOT have spoken "Done." on an error agent_end
    // (authoritative mapping: only stopReason "stop" without a
    // pending-pause flag speaks the affordance).
    expect(interjectorCalls.some((c) => c.message === 'Done.')).toBe(false);
  });

  it('restart-safe resume: dispatched worker persists sessionFile so resume can reopen it', async () => {
    const { faux, worker } = harness;

    // Two scripted turns: first for the initial dispatch, second
    // for the resume. Each call to the faux provider pops one entry.
    faux.setResponses([
      fauxAssistantMessage('First turn complete.', { stopReason: 'stop' }),
      fauxAssistantMessage('Continuing from where we left off.', { stopReason: 'stop' }),
    ]);

    // Initial dispatch → completed. This populates the workers row
    // with a valid session_file the resume path will reopen via
    // SessionManager.open().
    const handle = await worker.dispatch(integrationTask());
    const firstResult = await handle.done;
    await waitForDrain();
    expect(firstResult.status).toBe('completed');

    const rowAfterDispatch = await getWorker(harness.db, handle.workerId);
    expect(rowAfterDispatch?.sessionFile).toBeTruthy();

    // Now resume the "same" worker. Per the authoritative stopReason
    // mapping, a completed worker isn't normally resumed — you resume
    // idle_partial — but the runtime accepts any session file and
    // reopens it. This verifies the SessionManager.open() plumbing
    // works against a real on-disk JSONL file written by the first
    // dispatch, which is the Spike #4e property we care about.
    const resumeHandle = await worker.resume(handle.workerId, 'continue the task');
    const resumeResult = await resumeHandle.done;
    await waitForDrain();

    expect(resumeResult.status).toBe('completed');
    expect(faux.getPendingResponseCount()).toBe(0);
  });

  it('B1: runtime keys its active map by the db-assigned workerId', async () => {
    // Regression for PR-review blocker B1. Before the fix, PiRuntime
    // minted its own uuid and AgentWorker returned the db id, so any
    // subsequent `runtime.hasWorker(dbId)` / steer / cancel / abort
    // lookup by the db id missed the runtime's active map. This test
    // asserts the end-to-end contract: after AgentWorker.dispatch,
    // PiRuntime.hasWorker(dbId) must return true for the same id the
    // caller holds.
    const { faux, worker, runtime } = harness;

    // Script a response that never resolves on its own so we have a
    // live worker to introspect. A pending-but-never-fulfilled response
    // would hang; instead we use a factory that resolves after a
    // long delay to give us time to inspect, but the test exits fast
    // via await on handle.done at the end.
    faux.setResponses([fauxAssistantMessage('Done integration B1.', { stopReason: 'stop' })]);

    const handle = await worker.dispatch(integrationTask());

    // The runtime must recognize the caller's workerId as live.
    // Before the fix, this was `false` because the active map was
    // keyed under the runtime's internal uuid, not the db id.
    expect(runtime.hasWorker(handle.workerId)).toBe(true);

    // Drain the dispatch to terminal state so the afterEach cleanup
    // doesn't hit an in-flight worker.
    await handle.done;
    await waitForDrain();
  });

  it('B2: pi session receives Neura-loaded skills via skillsOverride', async () => {
    // Regression for PR-review blocker B2. Before the fix,
    // createAgentSession was constructed with no resourceLoader, so
    // pi's default ResourceLoader looked under its own conventions
    // (not `.neura/skills`), and workers ran as generic coding agents
    // with no SKILL.md instructions. This test proves the opposite:
    // a skill registered in Neura's SkillRegistry is visible to the
    // pi session at prompt time, via the DefaultResourceLoader
    // `skillsOverride` injection.
    const { faux, worker, registry } = harness;

    // Add a second uniquely-named skill to the registry alongside
    // the integration-test-skill the harness already installed.
    const hellmark: NeuraSkill = {
      name: 'hellmark-probe-skill',
      description:
        'A uniquely-named skill whose presence in the pi system prompt proves the skillsOverride wiring.',
      filePath: '/virtual/hellmark-probe-skill/SKILL.md',
      baseDir: '/virtual/hellmark-probe-skill',
      location: 'explicit',
      disableModelInvocation: false,
      allowedTools: ['get_current_time'],
      hasExplicitAllowedTools: true,
      metadata: {},
      body: 'hellmark probe body',
    };
    registry.replaceAll([...registry.list(), hellmark]);

    // Use a faux response factory that inspects the context's
    // systemPrompt at stream time. Pi's assembled system prompt should
    // contain the skill name because pi's formatSkillsForPrompt ran
    // over Neura's override output during session construction.
    let observedSystemPrompt = '';
    faux.setResponses([
      (context) => {
        observedSystemPrompt = context.systemPrompt ?? '';
        return fauxAssistantMessage('done', { stopReason: 'stop' });
      },
    ]);

    const handle = await worker.dispatch(integrationTask());
    await handle.done;
    await waitForDrain();

    // Pi's formatter wraps skills in an XML-ish block containing the
    // skill name. We don't over-specify the exact format because pi's
    // internal prompt layout may evolve — we just assert the unique
    // name is present somewhere in the system prompt.
    expect(observedSystemPrompt).toContain('hellmark-probe-skill');
  });
});
