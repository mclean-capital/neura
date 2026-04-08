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

export interface PresenceManager {
  /** Current presence state */
  readonly state: PresenceState;
  /** Transition to a specific mode (called by AI tool or idle timer). Returns true if transition occurred. */
  enterMode: (mode: 'passive' | 'active') => boolean;
  /** Signal that the wake word was detected */
  wake: (transcript: string) => void;
  /** Reset the active idle timer (call on user activity to prevent premature deactivation) */
  resetIdleTimer: () => void;
  /** Tear down — called on client disconnect */
  close: () => void;
}

/** Idle timeout: go passive after this long with no addressed speech in active mode */
const ACTIVE_IDLE_TIMEOUT_MS = 5 * 60_000; // 5 minutes

export function createPresenceManager(callbacks: PresenceCallbacks): PresenceManager {
  let state: PresenceState = 'passive';
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  function setState(newState: PresenceState) {
    if (state === newState) return;
    const prev = state;
    state = newState;
    log.info('state transition', { from: prev, to: newState });
    callbacks.onStateChange(newState);
  }

  function resetIdleTimer() {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (state === 'active') {
        log.info('active idle timeout, going passive');
        enterMode('passive');
      }
    }, ACTIVE_IDLE_TIMEOUT_MS);
  }

  function wake(transcript: string) {
    if (state !== 'passive') return;
    setState('active');
    resetIdleTimer();
    callbacks.onActivate(transcript);
  }

  function enterMode(mode: 'passive' | 'active'): boolean {
    if (state === 'idle') return false;

    if (mode === 'passive' && state === 'active') {
      if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = null;
      }
      setState('passive');
      callbacks.onDeactivate();
      return true;
    } else if (mode === 'active' && state === 'passive') {
      setState('active');
      resetIdleTimer();
      callbacks.onActivate('');
      return true;
    }
    return false;
  }

  function close() {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
    if (state === 'active') {
      callbacks.onDeactivate();
    }
    setState('idle');
  }

  // Notify initial state
  callbacks.onStateChange('passive');

  return {
    get state() {
      return state;
    },
    enterMode,
    wake,
    resetIdleTimer,
    close,
  };
}
