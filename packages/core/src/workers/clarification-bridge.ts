/**
 * Phase 6 — Clarification bridge
 *
 * Coordinates mid-execution clarification requests between a running
 * worker (the `request_clarification` pi custom tool) and the user's
 * voice session (the next input transcript after the question).
 *
 * Flow per the design doc's "Clarification protocol" section:
 *
 *   1. Worker calls `request_clarification({ question, context, urgency })`
 *      during its reasoning loop.
 *   2. Pi invokes the tool's execute function, which calls
 *      `bridge.askUser()`.
 *   3. Bridge marks the worker `blocked_clarifying` (via agent-worker).
 *   4. Bridge calls `voiceInterjector.interject(question, { immediate,
 *      bypassRateLimit: true })` so Grok speaks the question right now.
 *   5. Bridge returns a Promise<string> that resolves when the NEXT
 *      user input transcript arrives. The websocket layer calls
 *      `notifyUserTurn(text)` on every input transcript; the bridge
 *      resolves the first pending waiter FIFO.
 *   6. Abort signal propagation: if pi's abort fires (user said "stop"),
 *      the pending waiter rejects with `aborted` and the tool surfaces
 *      via pi's isError path.
 *   7. Once the user answers, the bridge optionally fires a
 *      fire-and-forget promotion worker that authors a draft skill
 *      from the clarification exchange.
 *
 * The promotion worker is stubbed as an optional callback. Phase 4
 * will build the write-skill prompt template; Phase 3 just wires the
 * dispatch point so the demo can show the parent worker resume
 * immediately after the user answers.
 */

import { Type, type Static } from '@sinclair/typebox';
import { Logger } from '@neura/utils/logger';
import type { NeuraAgentTool } from './neura-tools.js';
import type { VoiceInterjector } from './voice-fanout-bridge.js';

const log = new Logger('clarification-bridge');

interface PendingClarification {
  workerId: string;
  question: string;
  resolve: (answer: string) => void;
  reject: (err: Error) => void;
  /**
   * Optional hook the caller supplies to persist the user's answer as a
   * `clarification_response` / `approval_response` comment on the task
   * ticket (and flip the task status back to `in_progress`). Without
   * this the bridge would resolve the worker's Promise but the ticket
   * would stay in `awaiting_*` forever — `complete_task` would then be
   * blocked by the invariant layer's completion gate.
   */
  onAnswer?: (answer: string) => Promise<void> | void;
}

/** Context the clarification bridge needs beyond the interjector. */
export interface ClarificationBridgeOptions {
  voiceInterjector: VoiceInterjector;
  /** Called when a clarification blocks — agent-worker persists status. */
  onBlock?: (workerId: string) => Promise<void> | void;
  /** Called when a clarification ends — agent-worker persists status. */
  onUnblock?: (workerId: string) => Promise<void> | void;
  /**
   * Fire-and-forget promotion dispatcher. When a clarification
   * completes, this is called with the exchange context so a
   * promotion worker can author a draft skill from it. Phase 3 leaves
   * this optional so the core can run without the promotion layer.
   */
  onPromotion?: (ctx: {
    workerId: string;
    question: string;
    context: string;
    answer: string;
  }) => void;
}

/**
 * Async pub/sub between running workers and the voice session's
 * next-user-turn events.
 */
export class ClarificationBridge {
  private readonly opts: ClarificationBridgeOptions;
  private pending: PendingClarification[] = [];

  constructor(opts: ClarificationBridgeOptions) {
    this.opts = opts;
  }

  /**
   * Ask the user a clarifying question. Returns the user's next
   * spoken response. Throws `Error("clarification aborted")` if the
   * abort signal fires before the user answers (worker cancellation
   * path).
   *
   * `onAnswer` is invoked before the Promise resolves, giving callers a
   * place to persist a matching `clarification_response` /
   * `approval_response` comment on the ticket (the source of truth).
   * Resolution errors on `onAnswer` are logged but do not block the
   * worker — the bridge prioritizes unblocking the pi session over
   * durable state on this path.
   */
  async askUser(params: {
    workerId: string;
    question: string;
    context: string;
    urgency: 'blocking' | 'background';
    signal?: AbortSignal;
    onAnswer?: (answer: string) => Promise<void> | void;
  }): Promise<string> {
    const { workerId, question, context, urgency, signal, onAnswer } = params;

    try {
      await this.opts.onBlock?.(workerId);
    } catch (err) {
      log.warn('onBlock callback threw', { workerId, err: String(err) });
    }

    try {
      // Speak the question through the voice session. bypassRateLimit
      // because clarifications are always important — they're the
      // reason the worker paused.
      await this.opts.voiceInterjector.interject(`The worker needs your input: ${question}`, {
        immediate: urgency === 'blocking',
        bypassRateLimit: true,
      });

      // Wait for the next user turn, or for the abort signal to fire.
      const answer = await new Promise<string>((resolve, reject) => {
        const pending: PendingClarification = {
          workerId,
          question,
          resolve,
          reject,
          ...(onAnswer ? { onAnswer } : {}),
        };
        this.pending.push(pending);

        if (signal) {
          const onAbort = (): void => {
            const idx = this.pending.indexOf(pending);
            if (idx >= 0) this.pending.splice(idx, 1);
            reject(new Error('clarification aborted'));
          };
          if (signal.aborted) {
            onAbort();
          } else {
            signal.addEventListener('abort', onAbort, { once: true });
          }
        }
      });

      // Fire the promotion worker in parallel (fire-and-forget) so the
      // parent worker resumes immediately. Promotion runs while the
      // parent is already back in its reasoning loop — the demo's
      // "skill ready during the same voice session" moment.
      if (this.opts.onPromotion) {
        try {
          this.opts.onPromotion({ workerId, question, context, answer });
        } catch (err) {
          log.warn('promotion dispatch threw', { workerId, err: String(err) });
        }
      }

      return answer;
    } finally {
      try {
        await this.opts.onUnblock?.(workerId);
      } catch (err) {
        log.warn('onUnblock callback threw', { workerId, err: String(err) });
      }
    }
  }

  /**
   * Deliver the next user turn to the oldest pending clarification.
   * Called by the websocket layer from its onInputTranscript handler.
   * FIFO — one user turn answers one clarification. If no
   * clarifications are waiting, the turn is ignored (the user is just
   * talking to Grok normally).
   *
   * Returns true if the turn was consumed by a pending clarification,
   * false otherwise — callers can use this to decide whether to also
   * forward the turn to the normal voice session flow.
   */
  notifyUserTurn(text: string): boolean {
    const next = this.pending.shift();
    if (!next) return false;
    log.info('delivering user turn to clarification', {
      workerId: next.workerId,
      textPreview: text.slice(0, 80),
    });
    // Run the caller's persistence hook first so the ticket reflects
    // the user's answer BEFORE the worker's Promise resolves. If the
    // hook throws (e.g. invariant rejection, db hiccup), we still want
    // to unblock the worker — fire-and-log, but don't hold up the
    // Promise chain.
    if (next.onAnswer) {
      void Promise.resolve(next.onAnswer(text)).catch((err: unknown) => {
        log.warn('onAnswer persistence hook threw', {
          workerId: next.workerId,
          err: String(err),
        });
      });
    }
    next.resolve(text);
    return true;
  }

  /** How many clarifications are currently waiting for a user turn. */
  get pendingCount(): number {
    return this.pending.length;
  }

  /**
   * Reject every pending clarification. Used during shutdown or when
   * the voice session dies — pending workers should observe a clean
   * failure rather than hang forever.
   */
  rejectAll(reason: string): void {
    const all = this.pending.splice(0);
    for (const p of all) {
      p.reject(new Error(reason));
    }
  }
}

// ────────────────────────────────────────────────────────────────────
// request_clarification pi custom tool
// ────────────────────────────────────────────────────────────────────

const RequestClarificationParams = Type.Object({
  question: Type.String({
    description: 'Plain-language question to ask the user',
  }),
  context: Type.String({
    description: "What you're trying to do and why you're stuck",
  }),
  urgency: Type.Union([Type.Literal('blocking'), Type.Literal('background')], {
    description:
      "'blocking' breaks Grok's current response to speak the question now. 'background' queues it for the next natural turn.",
  }),
});

/**
 * Build the per-worker `request_clarification` pi custom tool. Closes
 * over the worker id so the tool's execute can mark the correct row
 * `blocked_clarifying` via the bridge's callbacks. PiRuntime calls
 * this from its `buildTools` factory with the current worker id.
 */
export function buildClarificationTool(
  workerId: string,
  bridge: ClarificationBridge
): NeuraAgentTool {
  type Params = Static<typeof RequestClarificationParams>;
  const tool: NeuraAgentTool = {
    name: 'request_clarification',
    label: 'Request Clarification',
    description:
      "Ask the user a clarifying question when you're stuck or need context you don't have. The user's spoken response is returned as the tool result so you can continue the task.",
    parameters: RequestClarificationParams,
    execute: async (_toolCallId, rawParams, signal) => {
      // Cast once to the schema-inferred type so the rest of the
      // function is strongly typed. NeuraAgentTool's default generic
      // narrows to the base TSchema so the inferred params shape
      // doesn't flow through automatically — this is the same
      // pattern `neura-tools.ts` uses for every custom tool.
      const params = rawParams as Params;
      const answer = await bridge.askUser({
        workerId,
        question: params.question,
        context: params.context,
        urgency: params.urgency,
        signal,
      });
      return {
        content: [{ type: 'text', text: answer }],
        details: { workerId, question: params.question, answer },
      };
    },
  };
  return tool;
}

/** Tool name constant. Historically used for beforeToolCall bypass (now removed). */
export const REQUEST_CLARIFICATION_TOOL_NAME = 'request_clarification';
