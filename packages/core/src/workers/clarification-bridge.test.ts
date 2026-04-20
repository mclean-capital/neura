/**
 * Tests for clarification-bridge.ts.
 */

import { describe, it, expect, vi } from 'vitest';
import type { VoiceInterjector } from './voice-fanout-bridge.js';
import { ClarificationBridge, buildClarificationTool } from './clarification-bridge.js';

function makeInterjector(): VoiceInterjector {
  return {
    interject: vi.fn().mockResolvedValue(undefined),
  };
}

describe('ClarificationBridge — askUser + notifyUserTurn round-trip', () => {
  it('resolves with the next user turn text', async () => {
    const bridge = new ClarificationBridge({ voiceInterjector: makeInterjector() });
    const answerPromise = bridge.askUser({
      workerId: 'w-1',
      question: 'Which test file?',
      context: 'triaging a failure',
      urgency: 'blocking',
    });
    // Wait a tick so the pending promise is registered.
    await new Promise((r) => setTimeout(r, 0));
    expect(bridge.pendingCount).toBe(1);

    bridge.notifyUserTurn('the billing test');
    const answer = await answerPromise;
    expect(answer).toBe('the billing test');
    expect(bridge.pendingCount).toBe(0);
  });

  it('delivers turns FIFO when multiple clarifications are pending', async () => {
    const bridge = new ClarificationBridge({ voiceInterjector: makeInterjector() });
    const first = bridge.askUser({
      workerId: 'w-1',
      question: 'q1',
      context: 'c1',
      urgency: 'blocking',
    });
    const second = bridge.askUser({
      workerId: 'w-2',
      question: 'q2',
      context: 'c2',
      urgency: 'background',
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(bridge.pendingCount).toBe(2);

    bridge.notifyUserTurn('answer 1');
    const ans1 = await first;
    expect(ans1).toBe('answer 1');
    expect(bridge.pendingCount).toBe(1);

    bridge.notifyUserTurn('answer 2');
    const ans2 = await second;
    expect(ans2).toBe('answer 2');
  });

  it('notifyUserTurn returns false when nothing is pending', () => {
    const bridge = new ClarificationBridge({ voiceInterjector: makeInterjector() });
    expect(bridge.notifyUserTurn('random user speech')).toBe(false);
  });

  it('notifyUserTurn returns true when it consumed a pending clarification', async () => {
    const bridge = new ClarificationBridge({ voiceInterjector: makeInterjector() });
    void bridge.askUser({
      workerId: 'w-1',
      question: 'q',
      context: 'c',
      urgency: 'blocking',
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(bridge.notifyUserTurn('yes')).toBe(true);
  });

  it('awaits the onAnswer hook before resolving the worker Promise', async () => {
    // Regression: the completion gate's countOpenRequests query runs
    // immediately after the worker unblocks. If onAnswer is
    // fire-and-forget, the approval_response comment may not have
    // committed when the worker calls complete_task, and the gate
    // rejects with "unresolved request" even though the user clearly
    // approved.
    const bridge = new ClarificationBridge({ voiceInterjector: makeInterjector() });
    const order: string[] = [];
    const hookPromise = bridge.askUser({
      workerId: 'w-1',
      question: 'ok?',
      context: '',
      urgency: 'blocking',
      onAnswer: async () => {
        await new Promise((r) => setTimeout(r, 25));
        order.push('hook_done');
      },
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(bridge.notifyUserTurn('yes')).toBe(true);
    await hookPromise;
    order.push('promise_resolved');
    expect(order).toEqual(['hook_done', 'promise_resolved']);
  });

  it('still resolves the worker even when onAnswer throws', async () => {
    const bridge = new ClarificationBridge({ voiceInterjector: makeInterjector() });
    const p = bridge.askUser({
      workerId: 'w-1',
      question: 'ok?',
      context: '',
      urgency: 'blocking',
      onAnswer: () => {
        throw new Error('db offline');
      },
    });
    await new Promise((r) => setTimeout(r, 0));
    bridge.notifyUserTurn('yes');
    await expect(p).resolves.toBe('yes');
  });

  it('ignores abort signal fired after the answer was consumed', async () => {
    // Regression: awaiting onAnswer widens the window where the
    // clarification Promise is still pending. If an AbortSignal fires
    // during that window, naive abort handling would reject an
    // already-answered clarification. The bridge must treat "already
    // consumed from pending" as "too late to abort."
    const bridge = new ClarificationBridge({ voiceInterjector: makeInterjector() });
    const controller = new AbortController();
    const p = bridge.askUser({
      workerId: 'w-1',
      question: 'ok?',
      context: '',
      urgency: 'blocking',
      signal: controller.signal,
      onAnswer: async () => {
        await new Promise((r) => setTimeout(r, 25));
      },
    });
    await new Promise((r) => setTimeout(r, 0));
    // Consume the answer, then abort mid-persistence.
    bridge.notifyUserTurn('yes');
    controller.abort();
    await expect(p).resolves.toBe('yes');
  });

  it('still rejects an abort that fires before any answer was consumed', async () => {
    const bridge = new ClarificationBridge({ voiceInterjector: makeInterjector() });
    const controller = new AbortController();
    const p = bridge.askUser({
      workerId: 'w-1',
      question: 'ok?',
      context: '',
      urgency: 'blocking',
      signal: controller.signal,
    });
    await new Promise((r) => setTimeout(r, 0));
    controller.abort();
    await expect(p).rejects.toThrow(/aborted/);
  });
});

describe('ClarificationBridge — voice interjection', () => {
  it('calls interject with blocking immediate flag for urgency=blocking', async () => {
    const interjectMock = vi.fn().mockResolvedValue(undefined);
    const interjector: VoiceInterjector = { interject: interjectMock };
    const bridge = new ClarificationBridge({ voiceInterjector: interjector });

    const p = bridge.askUser({
      workerId: 'w-1',
      question: 'Which env?',
      context: 'c',
      urgency: 'blocking',
    });
    await new Promise((r) => setTimeout(r, 0));
    bridge.notifyUserTurn('prod');
    await p;

    expect(interjectMock).toHaveBeenCalledTimes(1);
    const call = interjectMock.mock.calls[0];
    if (!call) throw new Error('expected interject call');
    expect(call[0]).toContain('Which env?');
    expect(call[1]).toEqual({ immediate: true, bypassRateLimit: true });
  });

  it('calls interject with immediate=false for urgency=background', async () => {
    const interjectMock = vi.fn().mockResolvedValue(undefined);
    const interjector: VoiceInterjector = { interject: interjectMock };
    const bridge = new ClarificationBridge({ voiceInterjector: interjector });

    const p = bridge.askUser({
      workerId: 'w-1',
      question: 'Hey',
      context: 'c',
      urgency: 'background',
    });
    await new Promise((r) => setTimeout(r, 0));
    bridge.notifyUserTurn('ok');
    await p;

    const call = interjectMock.mock.calls[0];
    if (!call) throw new Error('expected interject call');
    expect(call[1]).toEqual({ immediate: false, bypassRateLimit: true });
  });
});

describe('ClarificationBridge — block/unblock callbacks', () => {
  it('fires onBlock before interject and onUnblock after answer', async () => {
    const order: string[] = [];
    const bridge = new ClarificationBridge({
      voiceInterjector: {
        interject: () => {
          order.push('interject');
          return Promise.resolve();
        },
      },
      onBlock: () => {
        order.push('onBlock');
        return Promise.resolve();
      },
      onUnblock: () => {
        order.push('onUnblock');
        return Promise.resolve();
      },
    });

    const p = bridge.askUser({
      workerId: 'w-1',
      question: 'q',
      context: 'c',
      urgency: 'blocking',
    });
    await new Promise((r) => setTimeout(r, 0));
    bridge.notifyUserTurn('answer');
    await p;

    expect(order).toEqual(['onBlock', 'interject', 'onUnblock']);
  });

  it('still fires onUnblock even if the abort signal rejects the clarification', async () => {
    const order: string[] = [];
    const bridge = new ClarificationBridge({
      voiceInterjector: makeInterjector(),
      onBlock: () => {
        order.push('onBlock');
      },
      onUnblock: () => {
        order.push('onUnblock');
      },
    });

    const controller = new AbortController();
    const p = bridge.askUser({
      workerId: 'w-1',
      question: 'q',
      context: 'c',
      urgency: 'blocking',
      signal: controller.signal,
    });
    await new Promise((r) => setTimeout(r, 0));
    controller.abort();
    await expect(p).rejects.toThrow(/clarification aborted/);
    expect(order).toEqual(['onBlock', 'onUnblock']);
    expect(bridge.pendingCount).toBe(0);
  });
});

describe('ClarificationBridge — promotion dispatch', () => {
  it('fires onPromotion after the answer arrives', async () => {
    const promotionCalls: { workerId: string; answer: string }[] = [];
    const bridge = new ClarificationBridge({
      voiceInterjector: makeInterjector(),
      onPromotion: (ctx) => promotionCalls.push({ workerId: ctx.workerId, answer: ctx.answer }),
    });

    const p = bridge.askUser({
      workerId: 'w-42',
      question: 'How do you run tests?',
      context: 'no test runner detected',
      urgency: 'blocking',
    });
    await new Promise((r) => setTimeout(r, 0));
    bridge.notifyUserTurn('bun test in the root dir');
    await p;

    expect(promotionCalls).toEqual([{ workerId: 'w-42', answer: 'bun test in the root dir' }]);
  });

  it('swallows promotion dispatch errors so the parent worker resumes cleanly', async () => {
    const bridge = new ClarificationBridge({
      voiceInterjector: makeInterjector(),
      onPromotion: () => {
        throw new Error('promotion boom');
      },
    });

    const p = bridge.askUser({
      workerId: 'w-1',
      question: 'q',
      context: 'c',
      urgency: 'blocking',
    });
    await new Promise((r) => setTimeout(r, 0));
    bridge.notifyUserTurn('answer');
    // The parent worker's tool call must still resolve successfully
    // even if the fire-and-forget promotion dispatch threw.
    await expect(p).resolves.toBe('answer');
  });
});

describe('ClarificationBridge — rejectAll', () => {
  it('rejects every pending clarification with the given reason', async () => {
    const bridge = new ClarificationBridge({ voiceInterjector: makeInterjector() });
    const p1 = bridge.askUser({
      workerId: 'w-1',
      question: 'q1',
      context: 'c',
      urgency: 'blocking',
    });
    const p2 = bridge.askUser({
      workerId: 'w-2',
      question: 'q2',
      context: 'c',
      urgency: 'blocking',
    });
    await new Promise((r) => setTimeout(r, 0));

    bridge.rejectAll('voice session closed');
    await expect(p1).rejects.toThrow(/voice session closed/);
    await expect(p2).rejects.toThrow(/voice session closed/);
    expect(bridge.pendingCount).toBe(0);
  });
});

describe('buildClarificationTool', () => {
  it('returns a NeuraAgentTool with the request_clarification name', () => {
    const bridge = new ClarificationBridge({ voiceInterjector: makeInterjector() });
    const tool = buildClarificationTool('w-1', bridge);
    expect(tool.name).toBe('request_clarification');
    expect(tool.label).toBeTruthy();
    expect(tool.description).toBeTruthy();
    expect(typeof tool.execute).toBe('function');
  });

  it('execute() routes through bridge.askUser and returns the user answer', async () => {
    const bridge = new ClarificationBridge({ voiceInterjector: makeInterjector() });
    const tool = buildClarificationTool('w-1', bridge);

    const resultPromise = tool.execute(
      'call-1',
      {
        question: 'Which file?',
        context: 'no file specified',
        urgency: 'blocking',
      },
      undefined
    );
    await new Promise((r) => setTimeout(r, 0));
    bridge.notifyUserTurn('the auth one');

    const result = await resultPromise;
    expect(result.content[0]).toEqual({ type: 'text', text: 'the auth one' });
    const details = result.details as { workerId: string; answer: string };
    expect(details.workerId).toBe('w-1');
    expect(details.answer).toBe('the auth one');
  });
});
