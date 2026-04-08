import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PgliteStore } from './stores/pglite-store.js';
import { createDiscoveryLoop } from './discovery-loop.js';
import type { DiscoveryNotification } from './discovery-loop.js';

// Mock @google/genai so no real API call is attempted
vi.mock('@google/genai', () => {
  class MockGoogleGenAI {
    models = {
      generateContent: () => Promise.reject(new Error('mocked')),
    };
  }
  return { GoogleGenAI: MockGoogleGenAI };
});

let store: PgliteStore;

beforeEach(async () => {
  store = await PgliteStore.create(); // in-memory
});

afterEach(async () => {
  await store.close();
});

describe('DiscoveryLoop', () => {
  it('tick() with no open items returns early (no notification)', async () => {
    const onNotifications = vi.fn();
    const loop = createDiscoveryLoop({
      store,
      googleApiKey: 'fake-key',
      onNotifications,
    });

    await loop.tick();
    expect(onNotifications).not.toHaveBeenCalled();
  });

  it('tick() with items but no deadlines returns early (no notification)', async () => {
    await store.createWorkItem('No deadline task', 'high');
    await store.createWorkItem('Another no deadline', 'medium');

    const onNotifications = vi.fn();
    const loop = createDiscoveryLoop({
      store,
      googleApiKey: 'fake-key',
      onNotifications,
    });

    await loop.tick();
    expect(onNotifications).not.toHaveBeenCalled();
  });

  it('tick() with an overdue item fires the notification callback', async () => {
    // Use a date far in the past (2 days ago) so timezone offsets from TIMESTAMP column don't matter
    const pastDate = new Date(Date.now() - 2 * 24 * 60 * 60_000).toISOString();
    await store.createWorkItem('Overdue task', 'high', { dueAt: pastDate });

    const onNotifications = vi.fn();
    const loop = createDiscoveryLoop({
      store,
      googleApiKey: 'fake-key',
      onNotifications,
    });

    await loop.tick();

    expect(onNotifications).toHaveBeenCalledTimes(1);
    const [summary, items] = onNotifications.mock.calls[0] as [string, DiscoveryNotification[]];
    // Gemini call is mocked to fail — fallback summary should be used
    expect(summary).toContain('Overdue task');
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe('Overdue task');
    expect(items[0].reason).toMatch(/overdue/i);
  });

  it('tick() with an item due within 15 minutes fires the notification callback', async () => {
    // Create the item with a due date, then read back the stored value to account for
    // PGlite TIMESTAMP (no timezone) interpretation shifts, and fake Date.now to be
    // 5 minutes before the stored dueAt.
    const nominalDue = new Date(Date.now() + 5 * 60_000).toISOString();
    await store.createWorkItem('Due soon task', 'medium', { dueAt: nominalDue });

    const openItems = await store.getOpenWorkItems();
    const storedDueAt = new Date(openItems[0].dueAt!).getTime();

    // Set "now" to 5 minutes before the stored dueAt so the item is due in 5 minutes
    const fakeNow = storedDueAt - 5 * 60_000;
    vi.useFakeTimers({ now: fakeNow });

    const onNotifications = vi.fn();
    const loop = createDiscoveryLoop({
      store,
      googleApiKey: 'fake-key',
      onNotifications,
    });

    await loop.tick();

    vi.useRealTimers();

    expect(onNotifications).toHaveBeenCalledTimes(1);
    const [summary, items] = onNotifications.mock.calls[0] as [string, DiscoveryNotification[]];
    expect(summary).toContain('Due soon task');
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe('Due soon task');
    expect(items[0].reason).toMatch(/due in/i);
  });

  it('start()/stop() lifecycle works', () => {
    const loop = createDiscoveryLoop({
      store,
      googleApiKey: 'fake-key',
    });

    // Should not throw
    expect(() => loop.start()).not.toThrow();
    expect(() => loop.stop()).not.toThrow();
  });
});
