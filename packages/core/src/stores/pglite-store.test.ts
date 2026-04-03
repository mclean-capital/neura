import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { PgliteStore } from './pglite-store.js';

let store: PgliteStore;

beforeEach(async () => {
  store = await PgliteStore.create(); // in-memory
});

afterEach(async () => {
  await store.close();
});

describe('PgliteStore', () => {
  describe('sessions', () => {
    it('creates a session and returns an id', async () => {
      const id = await store.createSession('grok', 'gemini');
      expect(id).toBeTruthy();
      expect(typeof id).toBe('string');
    });

    it('retrieves created sessions', async () => {
      const id = await store.createSession('grok', 'gemini');
      const sessions = await store.getSessions();

      expect(sessions).toHaveLength(1);
      expect(sessions[0].id).toBe(id);
      expect(sessions[0].voiceProvider).toBe('grok');
      expect(sessions[0].visionProvider).toBe('gemini');
      expect(sessions[0].endedAt).toBeNull();
    });

    it('ends a session with cost and duration', async () => {
      const id = await store.createSession('grok', 'gemini');
      await store.endSession(id, 0.42);

      const sessions = await store.getSessions();
      expect(sessions[0].endedAt).toBeTruthy();
      expect(sessions[0].costUsd).toBeCloseTo(0.42);
      expect(sessions[0].durationMs).toBeGreaterThanOrEqual(0);
    });

    it('respects limit parameter', async () => {
      await store.createSession('grok', 'gemini');
      await store.createSession('grok', 'gemini');
      await store.createSession('grok', 'gemini');

      const sessions = await store.getSessions(2);
      expect(sessions).toHaveLength(2);
    });

    it('returns all created sessions', async () => {
      const id1 = await store.createSession('grok', 'gemini');
      const id2 = await store.createSession('grok', 'gemini');

      const sessions = await store.getSessions();
      const ids = sessions.map((s) => s.id);
      expect(ids).toContain(id1);
      expect(ids).toContain(id2);
    });
  });

  describe('transcripts', () => {
    it('appends transcript entries', async () => {
      const sessionId = await store.createSession('grok', 'gemini');
      await store.appendTranscript(sessionId, 'user', 'Hello');
      await store.appendTranscript(sessionId, 'assistant', 'Hi there');

      const entries = await store.getTranscript(sessionId);
      expect(entries).toHaveLength(2);
      expect(entries[0].role).toBe('user');
      expect(entries[0].text).toBe('Hello');
      expect(entries[1].role).toBe('assistant');
      expect(entries[1].text).toBe('Hi there');
    });

    it('returns empty array for unknown session', async () => {
      const entries = await store.getTranscript('nonexistent');
      expect(entries).toHaveLength(0);
    });

    it('preserves insertion order', async () => {
      const sessionId = await store.createSession('grok', 'gemini');
      await store.appendTranscript(sessionId, 'user', 'First');
      await store.appendTranscript(sessionId, 'assistant', 'Second');
      await store.appendTranscript(sessionId, 'user', 'Third');

      const entries = await store.getTranscript(sessionId);
      expect(entries.map((e) => e.text)).toEqual(['First', 'Second', 'Third']);
    });
  });

  describe('identity', () => {
    it('seeds default identity on creation', async () => {
      const identity = await store.getIdentity();
      expect(identity.length).toBeGreaterThanOrEqual(4);

      const attributes = identity.map((e) => e.attribute);
      expect(attributes).toContain('base_personality');
      expect(attributes).toContain('tone');
      expect(attributes).toContain('verbosity');
      expect(attributes).toContain('filler_words');

      expect(identity.every((e) => e.source === 'default')).toBe(true);
    });

    it('upserts identity (insert + update)', async () => {
      await store.upsertIdentity('tone', 'warm and friendly', 'user_feedback', 'session-1');

      const identity = await store.getIdentity();
      const tone = identity.find((e) => e.attribute === 'tone');
      expect(tone).toBeDefined();
      expect(tone!.value).toBe('warm and friendly');
      expect(tone!.source).toBe('user_feedback');
      expect(tone!.sourceSessionId).toBe('session-1');
    });

    it('adds new identity attributes', async () => {
      await store.upsertIdentity('humor', 'dry wit', 'user_feedback');

      const identity = await store.getIdentity();
      const humor = identity.find((e) => e.attribute === 'humor');
      expect(humor).toBeDefined();
      expect(humor!.value).toBe('dry wit');
    });
  });

  describe('user profile', () => {
    it('creates user profile entries', async () => {
      await store.upsertUserProfile('name', 'Don', 0.9, 'session-1');
      await store.upsertUserProfile('role', 'founder', 0.8);

      const profile = await store.getUserProfile();
      expect(profile).toHaveLength(2);
      expect(profile[0].field).toBe('name'); // higher confidence first
      expect(profile[0].value).toBe('Don');
    });

    it('deduplicates on (field, value)', async () => {
      await store.upsertUserProfile('name', 'Don', 0.7);
      await store.upsertUserProfile('name', 'Don', 0.9);

      const profile = await store.getUserProfile();
      const names = profile.filter((p) => p.field === 'name');
      expect(names).toHaveLength(1);
      expect(names[0].confidence).toBe(0.9); // GREATEST
    });

    it('allows different values for same field', async () => {
      await store.upsertUserProfile('interest', 'AI', 0.8);
      await store.upsertUserProfile('interest', 'music', 0.7);

      const profile = await store.getUserProfile();
      const interests = profile.filter((p) => p.field === 'interest');
      expect(interests).toHaveLength(2);
    });
  });

  describe('facts', () => {
    it('creates and retrieves facts', async () => {
      const id = await store.upsertFact('User prefers TypeScript', 'technical', [
        'typescript',
        'preferences',
      ]);
      expect(id).toBeTruthy();

      const facts = await store.getFacts();
      expect(facts).toHaveLength(1);
      expect(facts[0].content).toBe('User prefers TypeScript');
      expect(facts[0].category).toBe('technical');
      expect(facts[0].tags).toEqual(['typescript', 'preferences']);
    });

    it('filters by category', async () => {
      await store.upsertFact('Fact A', 'technical', []);
      await store.upsertFact('Fact B', 'personal', []);

      const techFacts = await store.getFacts({ category: 'technical' });
      expect(techFacts).toHaveLength(1);
      expect(techFacts[0].content).toBe('Fact A');
    });

    it('filters by minConfidence', async () => {
      await store.upsertFact('Low confidence', 'general', [], undefined, 0.3);
      await store.upsertFact('High confidence', 'general', [], undefined, 0.9);

      const highFacts = await store.getFacts({ minConfidence: 0.5 });
      expect(highFacts).toHaveLength(1);
      expect(highFacts[0].content).toBe('High confidence');
    });

    it('increments access count on touch', async () => {
      const id = await store.upsertFact('Test fact', 'general', []);
      await store.touchFact(id);
      await store.touchFact(id);

      const facts = await store.getFacts();
      expect(facts[0].accessCount).toBe(2);
      expect(facts[0].lastAccessedAt).toBeTruthy();
    });

    it('deletes facts', async () => {
      const id = await store.upsertFact('To be deleted', 'general', []);
      await store.deleteFact(id);

      const facts = await store.getFacts();
      expect(facts).toHaveLength(0);
    });

    it('searches facts by text', async () => {
      await store.upsertFact('User lives in Seattle', 'personal', []);
      await store.upsertFact('User uses VS Code', 'technical', []);

      const results = await store.searchFacts('Seattle');
      expect(results).toHaveLength(1);
      expect(results[0].content).toBe('User lives in Seattle');
    });

    it('searches facts by vector embedding', async () => {
      // Create a 768-dim vector (simplified: mostly zeros with a few values)
      const vec1 = new Array(768).fill(0);
      vec1[0] = 1.0;
      vec1[1] = 0.5;
      const vec2 = new Array(768).fill(0);
      vec2[0] = 0.9;
      vec2[1] = 0.4;
      const vec3 = new Array(768).fill(0);
      vec3[0] = 0.1;
      vec3[1] = 0.1;

      await store.upsertFact('Close match', 'general', [], undefined, 0.8, vec1);
      await store.upsertFact('Far match', 'general', [], undefined, 0.8, vec3);

      const results = await store.searchFacts('query', vec2, 1);
      expect(results).toHaveLength(1);
      expect(results[0].content).toBe('Close match');
    });
  });

  describe('preferences', () => {
    it('creates and retrieves preferences', async () => {
      await store.upsertPreference('Be more concise', 'response_style', 'session-1');

      const prefs = await store.getPreferences();
      expect(prefs).toHaveLength(1);
      expect(prefs[0].preference).toBe('Be more concise');
      expect(prefs[0].category).toBe('response_style');
    });

    it('filters by category', async () => {
      await store.upsertPreference('Short responses', 'response_style');
      await store.upsertPreference('Use snake_case', 'technical');

      const stylePrefs = await store.getPreferences({ category: 'response_style' });
      expect(stylePrefs).toHaveLength(1);
      expect(stylePrefs[0].preference).toBe('Short responses');
    });

    it('reinforces preferences', async () => {
      await store.upsertPreference('Be concise', 'response_style');

      const prefs = await store.getPreferences();
      const id = prefs[0].id;

      await store.reinforcePreference(id);
      await store.reinforcePreference(id);

      const updated = await store.getPreferences();
      expect(updated[0].reinforcementCount).toBe(3); // 1 initial + 2 reinforcements
      expect(updated[0].strength).toBeCloseTo(1.2); // 1.0 + 0.1 + 0.1
    });

    it('caps strength at 2.0', async () => {
      await store.upsertPreference('Strong pref', 'general');
      const prefs = await store.getPreferences();
      const id = prefs[0].id;

      // Reinforce many times
      for (let i = 0; i < 20; i++) {
        await store.reinforcePreference(id);
      }

      const updated = await store.getPreferences();
      expect(updated[0].strength).toBeLessThanOrEqual(2.0);
    });
  });

  describe('session summaries', () => {
    it('creates and retrieves session summaries', async () => {
      const sessionId = await store.createSession('grok', 'gemini');

      await store.createSessionSummary(sessionId, {
        summary: 'Discussed project architecture',
        topics: ['architecture', 'database'],
        keyDecisions: ['Use PGlite'],
        openThreads: ['Worker system design'],
        extractionModel: 'gemini-2.5-flash',
        extractionCostUsd: 0.002,
      });

      const summary = await store.getSessionSummary(sessionId);
      expect(summary).toBeDefined();
      expect(summary!.summary).toBe('Discussed project architecture');
      expect(summary!.topics).toEqual(['architecture', 'database']);
      expect(summary!.keyDecisions).toEqual(['Use PGlite']);
      expect(summary!.openThreads).toEqual(['Worker system design']);
      expect(summary!.extractionModel).toBe('gemini-2.5-flash');
      expect(summary!.extractionCostUsd).toBeCloseTo(0.002);
    });

    it('returns null for unknown session', async () => {
      const summary = await store.getSessionSummary('nonexistent');
      expect(summary).toBeNull();
    });

    it('returns recent summaries', async () => {
      const s1 = await store.createSession('grok', 'gemini');
      const s2 = await store.createSession('grok', 'gemini');

      await store.createSessionSummary(s1, {
        summary: 'First session',
        topics: [],
        keyDecisions: [],
        openThreads: [],
        extractionModel: 'gemini-2.5-flash',
        extractionCostUsd: null,
      });
      await store.createSessionSummary(s2, {
        summary: 'Second session',
        topics: [],
        keyDecisions: [],
        openThreads: [],
        extractionModel: 'gemini-2.5-flash',
        extractionCostUsd: null,
      });

      const summaries = await store.getRecentSummaries(2);
      expect(summaries).toHaveLength(2);
      const texts = summaries.map((s) => s.summary);
      expect(texts).toContain('First session');
      expect(texts).toContain('Second session');
    });
  });

  describe('extraction tracking', () => {
    it('creates and tracks extractions', async () => {
      const sessionId = await store.createSession('grok', 'gemini');
      const extractionId = await store.createExtraction(sessionId);
      expect(extractionId).toBeTruthy();

      const pending = await store.getPendingExtractions();
      expect(pending).toHaveLength(1);
      expect(pending[0].sessionId).toBe(sessionId);
      expect(pending[0].status).toBe('pending');
    });

    it('updates extraction status', async () => {
      const sessionId = await store.createSession('grok', 'gemini');
      const extractionId = await store.createExtraction(sessionId);

      await store.updateExtraction(extractionId, 'processing');

      const pending = await store.getPendingExtractions();
      expect(pending).toHaveLength(0); // no longer pending

      await store.updateExtraction(extractionId, 'completed', 5);

      // Verify completed (no direct getter, but pending should still be empty)
      const stillPending = await store.getPendingExtractions();
      expect(stillPending).toHaveLength(0);
    });

    it('records extraction errors', async () => {
      const sessionId = await store.createSession('grok', 'gemini');
      const extractionId = await store.createExtraction(sessionId);

      await store.updateExtraction(extractionId, 'failed', 0, 'API rate limit');

      const pending = await store.getPendingExtractions();
      expect(pending).toHaveLength(0);
    });
  });

  describe('getMemoryContext', () => {
    it('returns composite memory context', async () => {
      // Seed some data
      await store.upsertUserProfile('name', 'Don', 0.9);
      await store.upsertFact('Test fact', 'general', []);
      await store.upsertPreference('Be concise', 'response_style');

      const context = await store.getMemoryContext();
      expect(context.identity.length).toBeGreaterThanOrEqual(4); // defaults
      expect(context.userProfile).toHaveLength(1);
      expect(context.recentFacts).toHaveLength(1);
      expect(context.preferences).toHaveLength(1);
      expect(context.tokenEstimate).toBeGreaterThan(0);
    });

    it('trims facts when over token budget', async () => {
      // Create many facts to exceed a small token budget
      for (let i = 0; i < 20; i++) {
        await store.upsertFact(
          `This is a detailed fact number ${i} with lots of text to inflate token count`,
          'general',
          ['tag1', 'tag2']
        );
      }

      const context = await store.getMemoryContext({ maxTokens: 500 });
      // Should have fewer facts than total
      expect(context.recentFacts.length).toBeLessThan(20);
    });
  });

  describe('file persistence', () => {
    it('persists data across close and reopen', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'neura-pglite-test-'));
      const dataDir = path.join(tmpDir, 'pgdata');

      try {
        // Write data and close
        const store1 = await PgliteStore.create(dataDir);
        const sessionId = await store1.createSession('grok', 'gemini');
        await store1.appendTranscript(sessionId, 'user', 'Hello');
        await store1.appendTranscript(sessionId, 'assistant', 'Hi there');
        await store1.upsertFact('Persisted fact', 'general', []);
        await store1.close();

        // Reopen and verify
        const store2 = await PgliteStore.create(dataDir);
        const sessions = await store2.getSessions();
        expect(sessions).toHaveLength(1);
        expect(sessions[0].id).toBe(sessionId);

        const entries = await store2.getTranscript(sessionId);
        expect(entries).toHaveLength(2);
        expect(entries[0].text).toBe('Hello');
        expect(entries[1].text).toBe('Hi there');

        const facts = await store2.getFacts();
        expect(facts).toHaveLength(1);
        expect(facts[0].content).toBe('Persisted fact');

        // Identity should not be re-seeded (already exists)
        const identity = await store2.getIdentity();
        expect(identity).toHaveLength(4); // exactly 4, not 8

        await store2.close();
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });
});
