/**
 * Phase 6 — VoiceFanoutBridge
 *
 * Decouples pi's `Agent.subscribe()` event loop from Grok's websocket
 * interject latency. Pi dispatches subscribe listeners serially and awaits
 * each one before proceeding with the next event — which means a listener
 * that `await`s a 200–500ms voice interject per delta would stall the
 * agent loop by 10–25s for a verbose response with 50 deltas. That's a
 * real deadlock risk, not natural back-pressure.
 *
 * The fix (Codex-flagged in v2.1, corrected in v2.2 after the first sketch
 * had a zero-collapse coalescing bug): `push()` is synchronous and returns
 * immediately, dropping events into an in-process queue. A separate
 * `drain()` loop runs fire-and-forget, sleeps for the coalesce window so
 * contiguous text deltas can accumulate, batches them into a single
 * interject, and routes non-text events one at a time.
 *
 * Several properties worth keeping straight:
 *
 * 1. `push()` must stay synchronous and never throw. Pi's agent loop is
 *    the caller; if this function awaits or throws, the whole runtime
 *    stalls. The drain promise is caught via `.catch()` so errors become
 *    log lines, not unhandled rejections.
 *
 * 2. `drain()` sleeps BEFORE coalescing text deltas. A tight loop without
 *    the sleep only drains events already queued at entry — the "window"
 *    collapses to zero because the event loop never gets a chance to
 *    deliver new events. This was the v2.1 bug Codex caught.
 *
 * 3. `agent_end` handling is `stopReason`-aware. Per the authoritative
 *    mapping in docs/phase6-os-core.md, `"stop"` without a pending-pause
 *    flag speaks "Done.", `"stop"` WITH a pending-pause flag stays silent
 *    (the user knows they paused), and `"aborted"` / `"error"` stay silent
 *    (the orchestrator surfaces those via status transitions and error
 *    paths). `setPendingPauseFlag()` is called by agent-worker immediately
 *    before sending a pause steer so the bridge knows to suppress the
 *    "Done." affordance on the pause-ack turn.
 *
 * 4. Tool-call artifacts in `message_update` deltas are filtered at push
 *    time. Spike #4 observed Grok leaking tool-call JSON into the assistant
 *    text stream (e.g. `{"docName":"doc-alpha.pdf"}`); forwarding those to
 *    the voice pipeline would have Neura read raw JSON out loud.
 */

import type { AgentEvent } from '@mariozechner/pi-agent-core';
import { Logger } from '@neura/utils/logger';

const log = new Logger('voice-fanout-bridge');

/** Minimal contract the bridge needs from a voice provider. */
export interface VoiceInterjector {
  /**
   * Speak a message into the active voice session. Implementations may
   * return after the message is queued on the websocket, before audio
   * playback completes.
   *
   * `bypassRateLimit` lets callers skip any provider-side rate limiting
   * for clarification requests and worker completion announcements.
   * The bridge itself does not use it — ambient progress updates
   * respect the rate limit. Higher-level callers (clarification-bridge)
   * pass it explicitly when they need to.
   */
  interject(
    message: string,
    options: { immediate: boolean; bypassRateLimit?: boolean }
  ): Promise<void>;
}

/** Queue entry types. Kept narrow for exhaustiveness checking in `drain`. */
type QueueEntry =
  | { type: 'text_delta'; text: string; ts: number }
  | { type: 'tool_start'; toolName: string; ts: number }
  | { type: 'tool_end'; toolName: string; isError: boolean; ts: number }
  | { type: 'agent_end'; stopReason: string; ts: number };

export interface VoiceFanoutBridgeOptions {
  interjector: VoiceInterjector;
  /**
   * Coalesce window for text deltas. Pi deltas arriving within this window
   * are batched into a single `interject()` call. Default: 250ms.
   */
  coalesceBudgetMs?: number;
}

/** No-op interjector used when no voice session is currently attached. */
const NO_INTERJECTOR: VoiceInterjector = {
  interject: () => Promise.resolve(),
};

export class VoiceFanoutBridge {
  private interjector: VoiceInterjector;
  private readonly coalesceBudgetMs: number;
  private queue: QueueEntry[] = [];
  private draining = false;
  /**
   * Set by `agent-worker` immediately before sending a pause steer.
   * Cleared on the NEXT `agent_end`. Tells the bridge to stay silent on
   * the upcoming `stopReason: "stop"` because the user knows they paused.
   */
  private pendingPause = false;

  constructor(options: VoiceFanoutBridgeOptions) {
    this.interjector = options.interjector;
    this.coalesceBudgetMs = options.coalesceBudgetMs ?? 250;
  }

  /**
   * Swap the active interjector. Used by the server layer to attach a
   * GrokVoiceProvider when a client connects and detach when they
   * disconnect — the bridge itself is long-lived across the core
   * process, but the voice session it speaks through is per-client.
   * Pass `null` to detach and fall back to a no-op interjector that
   * silently drops everything.
   */
  setInterjector(interjector: VoiceInterjector | null): void {
    this.interjector = interjector ?? NO_INTERJECTOR;
  }

  /**
   * Synchronous listener — pi's agent loop is never blocked. Appends the
   * event to the queue and kicks the drain loop. Drain runs fire-and-forget
   * with a `.catch()` so errors become log lines, not unhandled rejections.
   */
  push(event: AgentEvent): void {
    if (event.type === 'message_update') {
      const delta = this.extractDelta(event);
      if (delta !== null) {
        const cleaned = stripToolCallArtifacts(delta);
        if (cleaned.length > 0) {
          this.queue.push({ type: 'text_delta', text: cleaned, ts: Date.now() });
        }
      }
    } else if (event.type === 'tool_execution_start') {
      this.queue.push({
        type: 'tool_start',
        toolName: event.toolName,
        ts: Date.now(),
      });
    } else if (event.type === 'tool_execution_end') {
      this.queue.push({
        type: 'tool_end',
        toolName: event.toolName,
        isError: event.isError,
        ts: Date.now(),
      });
    } else if (event.type === 'agent_end') {
      this.queue.push({
        type: 'agent_end',
        stopReason: extractStopReason(event),
        ts: Date.now(),
      });
    }

    this.drain().catch((err) => {
      log.error('voice fanout drain failed', { err: String(err) });
      // Release the guard so the next push() can restart the loop instead
      // of deadlocking on a stuck `draining = true`.
      this.draining = false;
    });
  }

  /**
   * Called by agent-worker before sending a pause steer. Tells the bridge
   * to suppress the "Done." affordance on the next `agent_end` because the
   * user explicitly requested the pause and doesn't need an audio confirm.
   */
  setPendingPauseFlag(): void {
    this.pendingPause = true;
  }

  /**
   * Drain entries from the queue, sleeping for the coalesce window when
   * the head is a text delta so contiguous deltas can accumulate. Loops
   * until the queue is empty, then releases the guard.
   */
  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.queue.length > 0) {
        const head = this.queue[0];
        if (!head) break;

        if (head.type === 'text_delta') {
          // IMPORTANT: sleep FIRST so new deltas from subsequent push()
          // calls land in the queue during the window. Without the sleep,
          // the inner loop drains only what was queued at entry and the
          // coalesce window collapses to zero (v2.1 bug).
          await sleep(this.coalesceBudgetMs);
          let coalesced = '';
          while (this.queue.length > 0 && this.queue[0]?.type === 'text_delta') {
            const next = this.queue.shift();
            if (next?.type === 'text_delta') {
              coalesced += next.text;
            }
          }
          if (coalesced.length > 0) {
            await this.interjector.interject(coalesced, { immediate: false });
          }
        } else {
          const ev = this.queue.shift();
          if (ev && ev.type !== 'text_delta') {
            await this.routeNonTextEvent(ev);
          }
        }
      }
    } finally {
      this.draining = false;
    }
  }

  private async routeNonTextEvent(ev: Exclude<QueueEntry, { type: 'text_delta' }>): Promise<void> {
    switch (ev.type) {
      case 'tool_start':
        await this.interjector.interject(`Running ${ev.toolName}...`, { immediate: false });
        break;
      case 'tool_end':
        if (ev.isError) {
          await this.interjector.interject(`${ev.toolName} failed.`, { immediate: false });
        }
        break;
      case 'agent_end':
        // Per the authoritative mapping:
        //   "stop" + pending pause  → silent (user knows)
        //   "stop" + no pending     → "Done."
        //   "aborted"               → silent (orchestrator announces cancel)
        //   "error"                 → silent (orchestrator announces error)
        //   anything else           → silent
        if (ev.stopReason === 'stop' && !this.pendingPause) {
          await this.interjector.interject('Done.', { immediate: false });
        }
        this.pendingPause = false;
        break;
    }
  }

  /**
   * Pull a string delta out of a pi `message_update` event. Returns null
   * for non-text deltas (thinking tokens, tool-call chunks, etc.) so
   * `push()` can ignore them. Kept as a method so we can adapt if pi's
   * event shape changes without rippling through the queue logic.
   */
  private extractDelta(event: AgentEvent): string | null {
    if (event.type !== 'message_update') return null;
    // Pi's assistant message event carries a `delta` field with the new
    // text chunk. Different pi versions shape this slightly differently;
    // we look on the event itself and on a nested `assistantMessageEvent`
    // container to cover both.
    const direct = (event as unknown as { delta?: unknown }).delta;
    if (typeof direct === 'string') return direct;
    const nested = (event as unknown as { assistantMessageEvent?: { delta?: unknown } })
      .assistantMessageEvent;
    if (nested && typeof nested.delta === 'string') return nested.delta;
    return null;
  }
}

/**
 * Regex filter for tool-call JSON artifacts leaking into the assistant
 * text stream. Observed in Spike #4: `{"docName":"doc-alpha.pdf"}paused`.
 * Conservative — nukes any `{...}` object literal inside the delta. If a
 * rare literal-prose mention of `{ x: 1 }` gets stripped, that's a better
 * failure mode than reading raw JSON out loud.
 *
 * Preserves leading/trailing whitespace on clean deltas so the coalescing
 * step can join contiguous text deltas without losing word boundaries —
 * only trims when a replacement actually happened (i.e. we removed a JSON
 * blob and need to clean up the residual whitespace).
 *
 * Exported for testing.
 */
export function stripToolCallArtifacts(text: string): string {
  const cleaned = text.replace(/\{[^{}\n]*?\}/g, '');
  if (cleaned === text) return text;
  return cleaned.trim();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Extract `stopReason` from a pi `agent_end` event. Pi's `AgentEvent`
 * shape for `agent_end` carries `messages: AgentMessage[]`; the
 * `stopReason` lives on the last assistant message in that array, not on
 * the event itself. We walk backwards from the end of the list and pull
 * the stopReason off the first assistant message we find. Defaults to
 * `"stop"` when the event is malformed or no assistant message exists
 * (e.g. agent_end fired before any assistant turn, which shouldn't
 * happen but we'd rather fail silent than throw).
 */
function extractStopReason(event: AgentEvent): string {
  if (event.type !== 'agent_end') return 'stop';
  const messages = (event as unknown as { messages?: unknown }).messages;
  if (!Array.isArray(messages)) return 'stop';
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i] as { role?: unknown; stopReason?: unknown } | undefined;
    if (msg?.role === 'assistant' && typeof msg.stopReason === 'string') {
      return msg.stopReason;
    }
  }
  return 'stop';
}
