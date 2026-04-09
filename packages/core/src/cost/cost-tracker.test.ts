import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CostTracker } from './cost-tracker.js';

const VOICE_RATE_PER_MS = 0.05 / 60_000;
const VISION_RATE_PER_MS = 0.002 / 60_000;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('CostTracker', () => {
  it('returns near-zero costs initially', () => {
    const tracker = new CostTracker();
    const update = tracker.getUpdate();

    expect(update.type).toBe('costUpdate');
    expect(update.sessionDurationMs).toBe(0);
    expect(update.estimatedCostUsd).toBe(0);
    expect(update.breakdown.voice).toBe(0);
    expect(update.breakdown.vision).toBe(0);
  });

  it('accumulates voice cost over time', () => {
    const tracker = new CostTracker();
    vi.advanceTimersByTime(60_000); // 1 minute

    const update = tracker.getUpdate();
    expect(update.sessionDurationMs).toBe(60_000);
    expect(update.breakdown.voice).toBeCloseTo(0.05, 5);
    expect(update.breakdown.vision).toBe(0);
  });

  it('tracks vision cost for a single source', () => {
    const tracker = new CostTracker();

    tracker.markVisionActive('camera');
    vi.advanceTimersByTime(60_000);
    const active = tracker.getUpdate();
    expect(active.breakdown.vision).toBeCloseTo(60_000 * VISION_RATE_PER_MS, 8);

    tracker.markVisionInactive('camera');
    vi.advanceTimersByTime(60_000);
    const after = tracker.getUpdate();
    // Vision cost should not increase after marking inactive
    expect(after.breakdown.vision).toBeCloseTo(60_000 * VISION_RATE_PER_MS, 8);
  });

  it('tracks dual vision sources independently', () => {
    const tracker = new CostTracker();

    tracker.markVisionActive('camera');
    tracker.markVisionActive('screen');
    vi.advanceTimersByTime(60_000);

    const update = tracker.getUpdate();
    // Two sources for 1 minute = 2 × single-source cost
    expect(update.breakdown.vision).toBeCloseTo(2 * 60_000 * VISION_RATE_PER_MS, 8);
  });

  it('markVisionActive is idempotent (??= operator)', () => {
    const tracker = new CostTracker();

    tracker.markVisionActive('camera');
    vi.advanceTimersByTime(30_000);
    // Calling again should NOT reset the start time
    tracker.markVisionActive('camera');
    vi.advanceTimersByTime(30_000);

    const update = tracker.getUpdate();
    // Full 60s of vision, not just the last 30s
    expect(update.breakdown.vision).toBeCloseTo(60_000 * VISION_RATE_PER_MS, 8);
  });

  it('startInterval sends periodic cost updates', () => {
    const tracker = new CostTracker();
    const sendFn = vi.fn();

    tracker.startInterval(sendFn, 1_000);

    vi.advanceTimersByTime(3_000);
    expect(sendFn).toHaveBeenCalledTimes(3);

    const lastCall = sendFn.mock.calls[2][0];
    expect(lastCall.type).toBe('costUpdate');
    expect(lastCall.sessionDurationMs).toBe(3_000);

    tracker.stopInterval();
  });

  it('stopInterval stops sending updates', () => {
    const tracker = new CostTracker();
    const sendFn = vi.fn();

    tracker.startInterval(sendFn, 1_000);
    vi.advanceTimersByTime(2_000);
    expect(sendFn).toHaveBeenCalledTimes(2);

    tracker.stopInterval();
    vi.advanceTimersByTime(3_000);
    expect(sendFn).toHaveBeenCalledTimes(2); // No new calls
  });

  it('stopInterval does not throw when no interval is running', () => {
    const tracker = new CostTracker();
    expect(() => tracker.stopInterval()).not.toThrow();
  });

  it('startInterval replaces a previous interval', () => {
    const tracker = new CostTracker();
    const sendFn1 = vi.fn();
    const sendFn2 = vi.fn();

    tracker.startInterval(sendFn1, 1_000);
    vi.advanceTimersByTime(1_000);
    expect(sendFn1).toHaveBeenCalledTimes(1);

    // Replace with new interval
    tracker.startInterval(sendFn2, 1_000);
    vi.advanceTimersByTime(1_000);
    expect(sendFn1).toHaveBeenCalledTimes(1); // Old stopped
    expect(sendFn2).toHaveBeenCalledTimes(1); // New running

    tracker.stopInterval();
  });

  it('total cost is voice + vision', () => {
    const tracker = new CostTracker();

    tracker.markVisionActive('camera');
    vi.advanceTimersByTime(60_000);

    const update = tracker.getUpdate();
    const expectedVoice = 60_000 * VOICE_RATE_PER_MS;
    const expectedVision = 60_000 * VISION_RATE_PER_MS;
    expect(update.estimatedCostUsd).toBeCloseTo(expectedVoice + expectedVision, 8);
  });
});
