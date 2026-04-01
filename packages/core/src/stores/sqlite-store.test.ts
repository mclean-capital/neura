import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { SqliteStore } from './sqlite-store.js';

let store: SqliteStore;

beforeEach(async () => {
  store = await SqliteStore.create(); // in-memory
});

afterEach(() => {
  store.close();
});

describe('SqliteStore', () => {
  describe('sessions', () => {
    it('creates a session and returns an id', () => {
      const id = store.createSession('grok', 'gemini');
      expect(id).toBeTruthy();
      expect(typeof id).toBe('string');
    });

    it('retrieves created sessions', () => {
      const id = store.createSession('grok', 'gemini');
      const sessions = store.getSessions();

      expect(sessions).toHaveLength(1);
      expect(sessions[0].id).toBe(id);
      expect(sessions[0].voiceProvider).toBe('grok');
      expect(sessions[0].visionProvider).toBe('gemini');
      expect(sessions[0].endedAt).toBeNull();
    });

    it('ends a session with cost and duration', () => {
      const id = store.createSession('grok', 'gemini');
      store.endSession(id, 0.42);

      const sessions = store.getSessions();
      expect(sessions[0].endedAt).toBeTruthy();
      expect(sessions[0].costUsd).toBe(0.42);
      expect(sessions[0].durationMs).toBeGreaterThanOrEqual(0);
    });

    it('respects limit parameter', () => {
      store.createSession('grok', 'gemini');
      store.createSession('grok', 'gemini');
      store.createSession('grok', 'gemini');

      const sessions = store.getSessions(2);
      expect(sessions).toHaveLength(2);
    });

    it('returns all created sessions', () => {
      const id1 = store.createSession('grok', 'gemini');
      const id2 = store.createSession('grok', 'gemini');

      const sessions = store.getSessions();
      const ids = sessions.map((s) => s.id);
      expect(ids).toContain(id1);
      expect(ids).toContain(id2);
    });
  });

  describe('transcripts', () => {
    it('appends transcript entries', () => {
      const sessionId = store.createSession('grok', 'gemini');
      store.appendTranscript(sessionId, 'user', 'Hello');
      store.appendTranscript(sessionId, 'assistant', 'Hi there');

      const entries = store.getTranscript(sessionId);
      expect(entries).toHaveLength(2);
      expect(entries[0].role).toBe('user');
      expect(entries[0].text).toBe('Hello');
      expect(entries[1].role).toBe('assistant');
      expect(entries[1].text).toBe('Hi there');
    });

    it('returns empty array for unknown session', () => {
      const entries = store.getTranscript('nonexistent');
      expect(entries).toHaveLength(0);
    });

    it('preserves insertion order', () => {
      const sessionId = store.createSession('grok', 'gemini');
      store.appendTranscript(sessionId, 'user', 'First');
      store.appendTranscript(sessionId, 'assistant', 'Second');
      store.appendTranscript(sessionId, 'user', 'Third');

      const entries = store.getTranscript(sessionId);
      expect(entries.map((e) => e.text)).toEqual(['First', 'Second', 'Third']);
    });
  });

  describe('file persistence', () => {
    it('persists data across close and reopen', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'neura-test-'));
      const dbPath = path.join(tmpDir, 'test.db');

      try {
        // Write data and close
        const store1 = await SqliteStore.create(dbPath);
        const sessionId = store1.createSession('grok', 'gemini');
        store1.appendTranscript(sessionId, 'user', 'Hello');
        store1.appendTranscript(sessionId, 'assistant', 'Hi there');
        store1.close();

        // Reopen and verify
        const store2 = await SqliteStore.create(dbPath);
        const sessions = store2.getSessions();
        expect(sessions).toHaveLength(1);
        expect(sessions[0].id).toBe(sessionId);

        const entries = store2.getTranscript(sessionId);
        expect(entries).toHaveLength(2);
        expect(entries[0].text).toBe('Hello');
        expect(entries[1].text).toBe('Hi there');
        store2.close();
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });
});
