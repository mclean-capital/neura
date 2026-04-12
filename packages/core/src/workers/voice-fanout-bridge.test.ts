/**
 * Tests for voice-fanout-bridge.ts.
 *
 * These tests intentionally skip pi's real `AgentEvent` shape and hand the
 * bridge minimally-typed synthetic events — the bridge extracts fields
 * defensively via `extractDelta` / `extractStopReason` precisely so it
 * survives pi version drift, so fabricating events to match pi's current
 * shape is both safe and stable.
 */

import { describe, it, expect, vi } from 'vitest';
import type { AgentEvent } from '@mariozechner/pi-agent-core';
import {
  VoiceFanoutBridge,
  stripToolCallArtifacts,
  type VoiceInterjector,
} from './voice-fanout-bridge.js';

/** Default worker id used by tests that don't care about identity. */
const W = 'worker-test';

function makeInterjector(): VoiceInterjector & {
  calls: { message: string; immediate: boolean; bypassRateLimit: boolean | undefined }[];
} {
  const calls: {
    message: string;
    immediate: boolean;
    bypassRateLimit: boolean | undefined;
  }[] = [];
  return {
    calls,
    interject: vi
      .fn()
      .mockImplementation(
        (message: string, options: { immediate: boolean; bypassRateLimit?: boolean }) => {
          calls.push({
            message,
            immediate: options.immediate,
            bypassRateLimit: options.bypassRateLimit,
          });
          return Promise.resolve();
        }
      ),
  };
}

/** Construct a synthetic `message_update` event with a delta field. */
function deltaEvent(delta: string): AgentEvent {
  return { type: 'message_update', delta } as unknown as AgentEvent;
}

function toolStart(toolName: string): AgentEvent {
  return { type: 'tool_execution_start', toolName } as unknown as AgentEvent;
}

function toolEnd(toolName: string, isError = false): AgentEvent {
  return { type: 'tool_execution_end', toolName, isError } as unknown as AgentEvent;
}

function agentEnd(stopReason: string): AgentEvent {
  // Pi's agent_end shape: `messages: AgentMessage[]`. stopReason lives on
  // the last assistant message, NOT on the event itself — matching how
  // extractStopReason walks messages backwards.
  return {
    type: 'agent_end',
    messages: [{ role: 'assistant', content: [], stopReason, usage: {}, timestamp: 0 }],
  } as unknown as AgentEvent;
}

/** Wait for the drain loop to finish processing pending events. */
async function flush(bridge: VoiceFanoutBridge, waitMs = 400): Promise<void> {
  void bridge; // bridge reference not needed here, just wait for timers
  await new Promise((r) => setTimeout(r, waitMs));
}

describe('VoiceFanoutBridge — synchronous push', () => {
  it('push() returns synchronously and never throws on well-formed events', () => {
    const bridge = new VoiceFanoutBridge({ interjector: makeInterjector() });
    // These calls must all return void immediately.
    bridge.push(W, deltaEvent('hello '));
    bridge.push(W, deltaEvent('world'));
    bridge.push(W, toolStart('create_task'));
    bridge.push(W, toolEnd('create_task'));
    bridge.push(W, agentEnd('stop'));
    // If any awaited, we wouldn't reach here without await.
    expect(true).toBe(true);
  });

  it('push() survives a malformed event without throwing', () => {
    const bridge = new VoiceFanoutBridge({ interjector: makeInterjector() });
    bridge.push(W, { type: 'unknown_event_type' } as unknown as AgentEvent);
    bridge.push(W, { type: 'message_update' } as unknown as AgentEvent); // no delta
    expect(true).toBe(true);
  });
});

describe('VoiceFanoutBridge — text delta coalescing', () => {
  it('coalesces contiguous text deltas into a single interject call', async () => {
    const interjector = makeInterjector();
    const bridge = new VoiceFanoutBridge({ interjector, coalesceBudgetMs: 50 });

    bridge.push(W, deltaEvent('Hello '));
    bridge.push(W, deltaEvent('there, '));
    bridge.push(W, deltaEvent('friend.'));

    await flush(bridge, 200);
    expect(interjector.calls.length).toBe(1);
    expect(interjector.calls[0]?.message).toBe('Hello there, friend.');
    expect(interjector.calls[0]?.immediate).toBe(false);
  });

  it('waits for the window so deltas arriving after push land in the same batch', async () => {
    const interjector = makeInterjector();
    const bridge = new VoiceFanoutBridge({ interjector, coalesceBudgetMs: 100 });

    // First delta fires the drain, which sleeps for 100ms before draining
    // the text batch. Deltas pushed within that window must coalesce.
    bridge.push(W, deltaEvent('First. '));
    await new Promise((r) => setTimeout(r, 30));
    bridge.push(W, deltaEvent('Second. '));
    await new Promise((r) => setTimeout(r, 30));
    bridge.push(W, deltaEvent('Third.'));

    await flush(bridge, 250);
    expect(interjector.calls.length).toBe(1);
    expect(interjector.calls[0]?.message).toBe('First. Second. Third.');
  });

  it('splits the batch when a non-text event interrupts the run', async () => {
    const interjector = makeInterjector();
    const bridge = new VoiceFanoutBridge({ interjector, coalesceBudgetMs: 50 });

    bridge.push(W, deltaEvent('Before. '));
    bridge.push(W, toolStart('describe_screen'));
    bridge.push(W, deltaEvent('After.'));

    await flush(bridge, 300);
    // Expect three calls: text batch 1 (with trailing space preserved),
    // tool_start affordance, text batch 2.
    const messages = interjector.calls.map((c) => c.message);
    expect(messages).toContain('Before. ');
    expect(messages).toContain('Running describe_screen...');
    expect(messages).toContain('After.');
    expect(interjector.calls.length).toBe(3);
  });
});

describe('VoiceFanoutBridge — tool events', () => {
  it('emits a "Running X..." interject on tool_start', async () => {
    const interjector = makeInterjector();
    const bridge = new VoiceFanoutBridge({ interjector, coalesceBudgetMs: 10 });

    bridge.push(W, toolStart('describe_screen'));
    await flush(bridge, 100);
    expect(interjector.calls[0]?.message).toBe('Running describe_screen...');
  });

  it('emits "X failed." on tool_end with isError=true', async () => {
    const interjector = makeInterjector();
    const bridge = new VoiceFanoutBridge({ interjector, coalesceBudgetMs: 10 });

    bridge.push(W, toolEnd('describe_screen', true));
    await flush(bridge, 100);
    expect(interjector.calls.find((c) => c.message === 'describe_screen failed.')).toBeDefined();
  });

  it('stays silent on tool_end with isError=false', async () => {
    const interjector = makeInterjector();
    const bridge = new VoiceFanoutBridge({ interjector, coalesceBudgetMs: 10 });

    bridge.push(W, toolEnd('describe_screen', false));
    await flush(bridge, 100);
    expect(interjector.calls.length).toBe(0);
  });
});

describe('VoiceFanoutBridge — agent_end stopReason mapping', () => {
  it('emits "Done." on natural completion (stop) without pending pause', async () => {
    const interjector = makeInterjector();
    const bridge = new VoiceFanoutBridge({ interjector, coalesceBudgetMs: 10 });

    bridge.push(W, agentEnd('stop'));
    await flush(bridge, 100);
    expect(interjector.calls[0]?.message).toBe('Done.');
  });

  it('stays silent on stop when pending pause flag is set', async () => {
    const interjector = makeInterjector();
    const bridge = new VoiceFanoutBridge({ interjector, coalesceBudgetMs: 10 });

    bridge.setPendingPauseFlag(W);
    bridge.push(W, agentEnd('stop'));
    await flush(bridge, 100);
    expect(interjector.calls.length).toBe(0);
  });

  it('clears pending pause flag after any agent_end', async () => {
    const interjector = makeInterjector();
    const bridge = new VoiceFanoutBridge({ interjector, coalesceBudgetMs: 10 });

    bridge.setPendingPauseFlag(W);
    bridge.push(W, agentEnd('stop'));
    await flush(bridge, 100);

    // The next agent_end should speak "Done." since the flag was cleared.
    bridge.push(W, agentEnd('stop'));
    await flush(bridge, 100);
    expect(interjector.calls.some((c) => c.message === 'Done.')).toBe(true);
  });

  it('stays silent on aborted stopReason (imperative cancel)', async () => {
    const interjector = makeInterjector();
    const bridge = new VoiceFanoutBridge({ interjector, coalesceBudgetMs: 10 });

    bridge.push(W, agentEnd('aborted'));
    await flush(bridge, 100);
    expect(interjector.calls.length).toBe(0);
  });

  it('stays silent on error stopReason (orchestrator surfaces the real error)', async () => {
    const interjector = makeInterjector();
    const bridge = new VoiceFanoutBridge({ interjector, coalesceBudgetMs: 10 });

    bridge.push(W, agentEnd('error'));
    await flush(bridge, 100);
    expect(interjector.calls.length).toBe(0);
  });

  it('C3: "Done." is sent with bypassRateLimit=true so recent progress does not mute it', async () => {
    // The voice provider rate-limits ambient interjects to one per 10s
    // unless bypassRateLimit is set. Completion announcements are
    // infrequent but load-bearing (the only audible signal that a
    // background task finished), so they must ALWAYS bypass the limiter.
    const interjector = makeInterjector();
    const bridge = new VoiceFanoutBridge({ interjector, coalesceBudgetMs: 10 });

    bridge.push(W, agentEnd('stop'));
    await flush(bridge, 100);

    const done = interjector.calls.find((c) => c.message === 'Done.');
    expect(done).toBeDefined();
    expect(done?.bypassRateLimit).toBe(true);
  });
});

describe('VoiceFanoutBridge — per-worker pendingPause isolation (B4)', () => {
  // The bridge is a singleton shared across every concurrent pi session.
  // Before B4 was fixed, `pendingPause` was a bridge-global boolean, so a
  // pause steer on worker A and a natural completion on worker B raced:
  // whichever agent_end arrived first consumed the flag. These tests pin
  // the fix — pause flags are keyed by workerId and don't cross-talk.

  it('pause flag set on worker A does not suppress worker B completion', async () => {
    const interjector = makeInterjector();
    const bridge = new VoiceFanoutBridge({ interjector, coalesceBudgetMs: 10 });

    bridge.setPendingPauseFlag('worker-a');
    // Worker B naturally completes first. Its "Done." must still speak.
    bridge.push('worker-b', agentEnd('stop'));
    await flush(bridge, 100);

    expect(interjector.calls.filter((c) => c.message === 'Done.').length).toBe(1);
  });

  it('worker B completion does not clear worker A pending pause flag', async () => {
    const interjector = makeInterjector();
    const bridge = new VoiceFanoutBridge({ interjector, coalesceBudgetMs: 10 });

    // A is paused, B completes and speaks "Done.", then A's actual
    // pause-ack arrives. A should STILL stay silent — the flag survived
    // B's agent_end.
    bridge.setPendingPauseFlag('worker-a');
    bridge.push('worker-b', agentEnd('stop'));
    await flush(bridge, 100);
    expect(interjector.calls.filter((c) => c.message === 'Done.').length).toBe(1);

    bridge.push('worker-a', agentEnd('stop'));
    await flush(bridge, 100);

    // Still exactly one "Done." — A's pause-ack stayed silent.
    expect(interjector.calls.filter((c) => c.message === 'Done.').length).toBe(1);
  });

  it('clears the pending pause flag only for the worker whose agent_end arrived', async () => {
    const interjector = makeInterjector();
    const bridge = new VoiceFanoutBridge({ interjector, coalesceBudgetMs: 10 });

    // Pause both A and B.
    bridge.setPendingPauseFlag('worker-a');
    bridge.setPendingPauseFlag('worker-b');

    // A's pause-ack lands. Silent (its own flag is set). B's flag is
    // unaffected.
    bridge.push('worker-a', agentEnd('stop'));
    await flush(bridge, 100);
    expect(interjector.calls.filter((c) => c.message === 'Done.').length).toBe(0);

    // B's pause-ack lands. Also silent (its own flag is still set).
    bridge.push('worker-b', agentEnd('stop'));
    await flush(bridge, 100);
    expect(interjector.calls.filter((c) => c.message === 'Done.').length).toBe(0);

    // Fresh agent_end on A — no flag, speaks "Done." as normal completion.
    bridge.push('worker-a', agentEnd('stop'));
    await flush(bridge, 100);
    expect(interjector.calls.filter((c) => c.message === 'Done.').length).toBe(1);
  });
});

describe('VoiceFanoutBridge — tool-call artifact stripping', () => {
  it('strips JSON object literals from text deltas before interjecting', async () => {
    const interjector = makeInterjector();
    const bridge = new VoiceFanoutBridge({ interjector, coalesceBudgetMs: 10 });

    bridge.push(W, deltaEvent('Uploading {"docName":"alpha.pdf"} now.'));
    await flush(bridge, 100);
    // The JSON blob should be gone.
    const spoken = interjector.calls[0]?.message ?? '';
    expect(spoken).not.toContain('docName');
    expect(spoken).toContain('Uploading');
    expect(spoken).toContain('now.');
  });

  it('drops the delta entirely if it is only JSON after stripping', async () => {
    const interjector = makeInterjector();
    const bridge = new VoiceFanoutBridge({ interjector, coalesceBudgetMs: 10 });

    bridge.push(W, deltaEvent('{"docName":"alpha.pdf"}'));
    await flush(bridge, 100);
    expect(interjector.calls.length).toBe(0);
  });
});

describe('VoiceFanoutBridge — agent loop never blocks', () => {
  it('push() does not wait for interject() to resolve', () => {
    let interjectResolved = false;
    const slowInterjector: VoiceInterjector = {
      interject: () =>
        new Promise((resolve) =>
          setTimeout(() => {
            interjectResolved = true;
            resolve();
          }, 500)
        ),
    };
    const bridge = new VoiceFanoutBridge({
      interjector: slowInterjector,
      coalesceBudgetMs: 10,
    });

    // Push 50 deltas as fast as possible — this simulates pi's agent loop
    // dispatching a verbose response. push() must return synchronously for
    // every one, without ever waiting on the slow interjector.
    const start = Date.now();
    for (let i = 0; i < 50; i++) {
      bridge.push(W, deltaEvent(`chunk ${i} `));
    }
    const elapsed = Date.now() - start;

    // 50 synchronous pushes should finish in well under 10ms. If any awaited
    // the 500ms interjector, we'd see multi-hundred-ms elapsed here.
    expect(elapsed).toBeLessThan(50);
    expect(interjectResolved).toBe(false);
  });

  it('drain errors are caught and do not kill the next push()', async () => {
    const interjectMock = vi.fn().mockRejectedValue(new Error('voice bridge dead'));
    const failingInterjector: VoiceInterjector = {
      interject: interjectMock,
    };
    const bridge = new VoiceFanoutBridge({
      interjector: failingInterjector,
      coalesceBudgetMs: 10,
    });

    bridge.push(W, deltaEvent('first'));
    await flush(bridge, 100);

    // After the drain error, a subsequent push should still schedule a
    // drain (not hit a stuck draining=true guard).
    bridge.push(W, deltaEvent('second'));
    await flush(bridge, 100);

    // Both interject attempts should have been made (and both rejected).
    expect(interjectMock).toHaveBeenCalledTimes(2);
  });
});

describe('stripToolCallArtifacts', () => {
  it('removes simple JSON blobs', () => {
    expect(stripToolCallArtifacts('hello {"a":1} world')).toBe('hello  world');
  });

  it('is idempotent on already-clean text', () => {
    expect(stripToolCallArtifacts('hello world')).toBe('hello world');
  });

  it('handles multiple blobs in one delta', () => {
    expect(stripToolCallArtifacts('{"a":1} and {"b":2}')).toBe('and');
  });

  it('returns empty for JSON-only input', () => {
    expect(stripToolCallArtifacts('{"a":1}')).toBe('');
  });
});
