/**
 * Discovery loop — makes Neura proactive.
 *
 * Runs on a fixed timer (default 15 minutes), reviews open work items,
 * checks deadlines, and notifies connected clients about items that need
 * attention. The loop creates work items but does NOT execute them —
 * that's the future Execution Loop.
 */

import { GoogleGenAI } from '@google/genai';
import { Logger } from '@neura/utils/logger';
import { IntervalTimer } from '@neura/utils';
import type { DataStore, WorkItemEntry } from '@neura/types';

const log = new Logger('discovery');

export interface DiscoveryNotification {
  id: string;
  title: string;
  reason: string;
}

export interface DiscoveryLoopOptions {
  store: DataStore;
  googleApiKey: string;
  intervalMs?: number;
  onNotifications?: (summary: string, items: DiscoveryNotification[]) => void;
}

export interface DiscoveryLoop {
  start(): void;
  stop(): void;
  tick(): Promise<void>;
}

const DEFAULT_INTERVAL_MS = 15 * 60_000;

export function createDiscoveryLoop(options: DiscoveryLoopOptions): DiscoveryLoop {
  const { store, googleApiKey, intervalMs = DEFAULT_INTERVAL_MS, onNotifications } = options;
  const ai = new GoogleGenAI({ apiKey: googleApiKey });
  let tickInProgress = false;

  const timer = new IntervalTimer(() => {
    void tick().catch((err) => log.warn('tick failed', { err: String(err) }));
  }, intervalMs);

  async function tick(): Promise<void> {
    if (tickInProgress) return;
    tickInProgress = true;
    try {
      await runTick();
    } finally {
      tickInProgress = false;
    }
  }

  async function runTick(): Promise<void> {
    const items = await store.getOpenWorkItems();
    if (items.length === 0) return;

    const now = new Date();
    const needsAttention: { item: WorkItemEntry; reason: string }[] = [];

    for (const item of items) {
      if (!item.dueAt) continue;
      const due = new Date(item.dueAt);
      const diffMs = due.getTime() - now.getTime();

      if (diffMs < 0) {
        needsAttention.push({ item, reason: `overdue by ${formatDuration(-diffMs)}` });
      } else if (diffMs < 15 * 60_000) {
        needsAttention.push({ item, reason: `due in ${formatDuration(diffMs)}` });
      }
    }

    if (needsAttention.length === 0) {
      log.debug('tick complete, no items need attention', { openItems: items.length });
      return;
    }

    log.info('items need attention', { count: needsAttention.length });

    // Use Gemini Flash for a conversational summary
    let summary: string;
    try {
      const itemList = needsAttention
        .map((a) => `- "${a.item.title}" (${a.item.priority} priority): ${a.reason}`)
        .join('\n');

      const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: [
          {
            role: 'user',
            parts: [
              {
                text: [
                  `Current time: ${now.toLocaleString()}.`,
                  ``,
                  `These tasks need the user's attention:`,
                  itemList,
                  ``,
                  `Write a brief, conversational summary (1-2 sentences) suitable for a voice assistant to speak aloud. Focus on what's most urgent.`,
                ].join('\n'),
              },
            ],
          },
        ],
      });
      summary = (response.text ?? '').trim();
    } catch (err) {
      log.warn('gemini summary failed, using fallback', { err: String(err) });
      summary =
        needsAttention.length === 1
          ? `Your task "${needsAttention[0].item.title}" is ${needsAttention[0].reason}.`
          : `You have ${needsAttention.length} tasks that need attention.`;
    }

    const notifications: DiscoveryNotification[] = needsAttention.map((a) => ({
      id: a.item.id,
      title: a.item.title,
      reason: a.reason,
    }));

    log.info('discovery tick complete', { summary, notifications: notifications.length });
    onNotifications?.(summary, notifications);
  }

  function start(): void {
    timer.start();
    log.info('discovery loop started', { intervalMs });
  }

  function stop(): void {
    timer.stop();
    log.info('discovery loop stopped');
  }

  return { start, stop, tick };
}

function formatDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes} minute${minutes !== 1 ? 's' : ''}`;
  const hours = Math.round(minutes / 60);
  return `${hours} hour${hours !== 1 ? 's' : ''}`;
}
