/**
 * Presence state machine for a single client connection.
 *
 * States:
 *   PASSIVE — listening for wake word, no Grok session
 *   ACTIVE  — full bidirectional conversation via Grok
 *   IDLE    — connection closed, cleanup complete
 *
 * Transitions:
 *   PASSIVE → ACTIVE  (wake word detected)
 *   ACTIVE  → PASSIVE (AI calls enter_mode, or idle timeout)
 *   ACTIVE  → IDLE    (client disconnects)
 *   PASSIVE → IDLE    (client disconnects)
 */

import { Logger } from '@neura/utils/logger';

const log = new Logger('presence');

export type PresenceState = 'passive' | 'active' | 'idle';

export interface PresenceCallbacks {
  /** Called when transitioning to ACTIVE — should create Grok session */
  onActivate: (wakeTranscript: string) => void;
  /** Called when transitioning to PASSIVE — should tear down Grok session */
  onDeactivate: () => void;
  /** Called on any state change — notify client */
  onStateChange: (state: PresenceState) => void;
}

/** Idle timeout: go passive after this long with no addressed speech in active mode */
const ACTIVE_IDLE_TIMEOUT_MS = 5 * 60_000; // 5 minutes

export class PresenceManager {
  private _state: PresenceState = 'passive';
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly callbacks: PresenceCallbacks;

  constructor(callbacks: PresenceCallbacks) {
    this.callbacks = callbacks;
    // Notify initial state
    callbacks.onStateChange('passive');
  }

  get state(): PresenceState {
    return this._state;
  }

  enterMode(mode: 'passive' | 'active'): boolean {
    if (this._state === 'idle') return false;

    if (mode === 'passive' && this._state === 'active') {
      if (this.idleTimer) {
        clearTimeout(this.idleTimer);
        this.idleTimer = null;
      }
      this.setState('passive');
      this.callbacks.onDeactivate();
      return true;
    } else if (mode === 'active' && this._state === 'passive') {
      this.setState('active');
      this.resetIdleTimer();
      this.callbacks.onActivate('');
      return true;
    }
    return false;
  }

  wake(transcript: string): void {
    if (this._state !== 'passive') return;
    this.setState('active');
    this.resetIdleTimer();
    this.callbacks.onActivate(transcript);
  }

  resetIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (this._state === 'active') {
        log.info('active idle timeout, going passive');
        this.enterMode('passive');
      }
    }, ACTIVE_IDLE_TIMEOUT_MS);
  }

  close(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    if (this._state === 'active') {
      this.callbacks.onDeactivate();
    }
    this.setState('idle');
  }

  private setState(newState: PresenceState): void {
    if (this._state === newState) return;
    const prev = this._state;
    this._state = newState;
    log.info('state transition', { from: prev, to: newState });
    this.callbacks.onStateChange(newState);
  }
}
