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
      // Create a 3072-dim vector (simplified: mostly zeros with a few values)
      const vec1 = new Array(3072).fill(0);
      vec1[0] = 1.0;
      vec1[1] = 0.5;
      const vec2 = new Array(3072).fill(0);
      vec2[0] = 0.9;
      vec2[1] = 0.4;
      const vec3 = new Array(3072).fill(0);
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

  describe('exportMemories / importMemories', () => {
    it('round-trips all memory tables through export → wipe → import', async () => {
      // Seed data
      await store.upsertIdentity('tone', 'casual', 'user_feedback', undefined);
      await store.upsertUserProfile('name', 'Don', 0.95, undefined);
      await store.upsertFact('Likes TypeScript', 'technical', ['lang'], undefined, 0.9);
      await store.upsertPreference('Be concise', 'response_style', undefined);
      // Reinforce preference to bump strength
      const prefs = await store.getPreferences();
      await store.reinforcePreference(prefs[0].id);

      const sessionId = await store.createSession('grok', 'gemini');
      await store.createSessionSummary(sessionId, {
        summary: 'Discussed TypeScript',
        topics: ['typescript'],
        keyDecisions: ['use strict mode'],
        openThreads: [],
        extractionModel: 'gemini-2.5-flash',
        extractionCostUsd: 0.002,
      });

      // Export
      const backup = await store.exportMemories();
      expect(backup.version).toBe(2);
      expect(backup.identity.length).toBeGreaterThanOrEqual(1);
      expect(backup.userProfile).toHaveLength(1);
      expect(backup.facts).toHaveLength(1);
      expect(backup.preferences).toHaveLength(1);
      expect(backup.sessionSummaries).toHaveLength(1);

      // Verify preference strength was preserved in export
      expect(backup.preferences[0].strength).toBeGreaterThan(1.0);
      expect(backup.preferences[0].reinforcementCount).toBe(2);

      // Import into a fresh store
      const store2 = await PgliteStore.create(); // fresh in-memory
      const result = await store2.importMemories(backup);
      expect(result.imported).toBeGreaterThan(0);

      // Verify all data restored
      const identity2 = await store2.getIdentity();
      const toneEntry = identity2.find((e) => e.attribute === 'tone');
      expect(toneEntry?.value).toBe('casual');
      expect(toneEntry?.source).toBe('user_feedback');

      const profile2 = await store2.getUserProfile();
      expect(profile2).toHaveLength(1);
      expect(profile2[0].field).toBe('name');
      expect(profile2[0].confidence).toBe(0.95);

      const facts2 = await store2.getFacts();
      expect(facts2).toHaveLength(1);
      expect(facts2[0].content).toBe('Likes TypeScript');
      expect(facts2[0].confidence).toBe(0.9);

      const prefs2 = await store2.getPreferences();
      expect(prefs2).toHaveLength(1);
      expect(prefs2[0].preference).toBe('Be concise');
      expect(prefs2[0].strength).toBeGreaterThan(1.0);
      expect(prefs2[0].reinforcementCount).toBe(2);

      const summaries2 = await store2.getRecentSummaries();
      expect(summaries2).toHaveLength(1);
      expect(summaries2[0].summary).toBe('Discussed TypeScript');
      expect(summaries2[0].topics).toEqual(['typescript']);

      await store2.close();
    });

    it('import is idempotent — re-importing same backup does not inflate values', async () => {
      await store.upsertPreference('Be verbose', 'response_style', undefined);
      const prefs = await store.getPreferences();
      const originalStrength = prefs[0].strength;

      const backup = await store.exportMemories();

      // Import into same store twice
      await store.importMemories(backup);
      await store.importMemories(backup);

      const prefs2 = await store.getPreferences();
      // GREATEST keeps the higher value, doesn't add — strength should not inflate
      expect(prefs2[0].strength).toBe(originalStrength);
    });

    it('handles empty backup gracefully', async () => {
      const store2 = await PgliteStore.create();
      const emptyBackup = await store2.exportMemories();

      // Identity has defaults, rest should be empty
      expect(emptyBackup.userProfile).toHaveLength(0);
      expect(emptyBackup.facts).toHaveLength(0);
      expect(emptyBackup.preferences).toHaveLength(0);
      expect(emptyBackup.sessionSummaries).toHaveLength(0);

      const result = await store.importMemories(emptyBackup);
      expect(result.skipped).toBe(0);

      await store2.close();
    });

    it('preserves fact accessCount and expiresAt through round-trip', async () => {
      await store.upsertFact('Expiring fact', 'general', [], undefined, 0.8);
      const facts = await store.getFacts();
      // Touch the fact to increment access count
      await store.touchFact(facts[0].id);
      await store.touchFact(facts[0].id);

      const backup = await store.exportMemories();
      expect(backup.facts[0].accessCount).toBe(2);

      const store2 = await PgliteStore.create();
      await store2.importMemories(backup);
      const facts2 = await store2.getFacts();
      expect(facts2[0].accessCount).toBe(2);

      await store2.close();
    });
  });

  describe('work items', () => {
    it('creates a work item and retrieves it by ID', async () => {
      const id = await store.createWorkItem('Buy groceries', 'medium');
      expect(id).toBeTruthy();

      const item = await store.getWorkItem(id);
      expect(item).not.toBeNull();
      expect(item!.title).toBe('Buy groceries');
      expect(item!.priority).toBe('medium');
      expect(item!.status).toBe('pending');
      expect(item!.description).toBeNull();
      expect(item!.dueAt).toBeNull();
      expect(item!.parentId).toBeNull();
      expect(item!.completedAt).toBeNull();
    });

    it('getOpenWorkItems returns only pending/in_progress items', async () => {
      const id1 = await store.createWorkItem('Pending task', 'medium');
      const id2 = await store.createWorkItem('In progress task', 'medium');
      const id3 = await store.createWorkItem('Done task', 'medium');
      const id4 = await store.createWorkItem('Cancelled task', 'medium');

      await store.updateWorkItem(id2, { status: 'in_progress' });
      await store.updateWorkItem(id3, { status: 'done' });
      await store.updateWorkItem(id4, { status: 'cancelled' });

      const open = await store.getOpenWorkItems();
      const openIds = open.map((i) => i.id);
      expect(openIds).toContain(id1);
      expect(openIds).toContain(id2);
      expect(openIds).not.toContain(id3);
      expect(openIds).not.toContain(id4);
    });

    it('getOpenWorkItems sorts by priority (high first) then due date', async () => {
      const idLow = await store.createWorkItem('Low priority', 'low', {
        dueAt: '2030-01-01T00:00:00Z',
      });
      const idHigh = await store.createWorkItem('High priority', 'high', {
        dueAt: '2030-06-01T00:00:00Z',
      });
      const idMedEarly = await store.createWorkItem('Medium early', 'medium', {
        dueAt: '2030-01-01T00:00:00Z',
      });
      const idMedLate = await store.createWorkItem('Medium late', 'medium', {
        dueAt: '2030-12-01T00:00:00Z',
      });

      const open = await store.getOpenWorkItems();
      const ids = open.map((i) => i.id);

      // High should be first
      expect(ids[0]).toBe(idHigh);
      // Medium items next, early due date first
      expect(ids[1]).toBe(idMedEarly);
      expect(ids[2]).toBe(idMedLate);
      // Low last
      expect(ids[3]).toBe(idLow);
    });

    it('updateWorkItem changes fields correctly', async () => {
      const id = await store.createWorkItem('Original title', 'low');
      await store.updateWorkItem(id, {
        title: 'Updated title',
        priority: 'high',
        description: 'A description',
      });

      const item = await store.getWorkItem(id);
      expect(item!.title).toBe('Updated title');
      expect(item!.priority).toBe('high');
      expect(item!.description).toBe('A description');
    });

    it('updateWorkItem sets completedAt when status changes to done', async () => {
      const id = await store.createWorkItem('Task to complete', 'medium');
      await store.updateWorkItem(id, { status: 'done' });

      const item = await store.getWorkItem(id);
      expect(item!.status).toBe('done');
      expect(item!.completedAt).toBeTruthy();
    });

    it('deleteWorkItem removes the item', async () => {
      const id = await store.createWorkItem('To delete', 'low');
      expect(await store.getWorkItem(id)).not.toBeNull();

      await store.deleteWorkItem(id);
      expect(await store.getWorkItem(id)).toBeNull();
    });

    it('getWorkItem returns null for nonexistent ID', async () => {
      const item = await store.getWorkItem('nonexistent-id');
      expect(item).toBeNull();
    });

    it('createWorkItem with all optional fields', async () => {
      const parentId = await store.createWorkItem('Parent task', 'high');
      const sessionId = await store.createSession('grok', 'gemini');

      const childId = await store.createWorkItem('Child task', 'medium', {
        description: 'Detailed description',
        dueAt: '2030-06-15T10:00:00Z',
        parentId,
        sourceSessionId: sessionId,
      });

      const item = await store.getWorkItem(childId);
      expect(item!.description).toBe('Detailed description');
      expect(item!.dueAt).toBeTruthy();
      expect(item!.parentId).toBe(parentId);
      expect(item!.sourceSessionId).toBe(sessionId);
    });
  });

  // --- Phase 6b: task-driven execution tests ---

  describe('Phase 6b: expanded WorkItem schema', () => {
    it('createWorkItem defaults Phase 6b fields correctly', async () => {
      const id = await store.createWorkItem('Fresh task', 'medium');
      const item = await store.getWorkItem(id);

      expect(item!.goal).toBeNull();
      expect(item!.context).toBeNull();
      expect(item!.relatedSkills).toEqual([]);
      expect(item!.repoPath).toBeNull();
      expect(item!.baseBranch).toBeNull();
      expect(item!.workerId).toBeNull();
      expect(item!.source).toBe('user');
      expect(item!.version).toBe(0);
      expect(item!.leaseExpiresAt).toBeNull();
    });

    it('createWorkItem accepts Phase 6b fields', async () => {
      const id = await store.createWorkItem('Briefed task', 'high', {
        goal: 'Upload the report to the CMS',
        context: {
          references: ['~/docs/report.pdf'],
          constraints: ["don't overwrite existing drafts"],
          acceptanceCriteria: ['published article appears in CMS index'],
        },
        relatedSkills: ['cms-upload-guide'],
        repoPath: '/Users/me/projects/blog',
        baseBranch: 'main',
        source: 'user',
      });

      const item = await store.getWorkItem(id);
      expect(item!.goal).toBe('Upload the report to the CMS');
      expect(item!.context?.references).toEqual(['~/docs/report.pdf']);
      expect(item!.context?.constraints).toEqual(["don't overwrite existing drafts"]);
      expect(item!.relatedSkills).toEqual(['cms-upload-guide']);
      expect(item!.repoPath).toBe('/Users/me/projects/blog');
      expect(item!.baseBranch).toBe('main');
      expect(item!.source).toBe('user');
    });

    it('accepts all new status values without CHECK-constraint violation', async () => {
      for (const status of [
        'awaiting_dispatch',
        'awaiting_clarification',
        'awaiting_approval',
        'paused',
      ] as const) {
        const id = await store.createWorkItem(`Test ${status}`, 'medium');
        await store.updateWorkItem(id, { status });
        const item = await store.getWorkItem(id);
        expect(item!.status).toBe(status);
      }
    });

    it('getOpenWorkItems returns all non-terminal statuses including Phase 6b', async () => {
      const idDispatch = await store.createWorkItem('awaiting dispatch', 'medium');
      await store.updateWorkItem(idDispatch, { status: 'awaiting_dispatch' });

      const idClarify = await store.createWorkItem('awaiting clarification', 'medium');
      await store.updateWorkItem(idClarify, { status: 'awaiting_clarification' });

      const idApprove = await store.createWorkItem('awaiting approval', 'medium');
      await store.updateWorkItem(idApprove, { status: 'awaiting_approval' });

      const idPaused = await store.createWorkItem('paused', 'medium');
      await store.updateWorkItem(idPaused, { status: 'paused' });

      const idDone = await store.createWorkItem('done', 'medium');
      await store.updateWorkItem(idDone, { status: 'done' });

      const openIds = (await store.getOpenWorkItems()).map((i) => i.id);
      expect(openIds).toContain(idDispatch);
      expect(openIds).toContain(idClarify);
      expect(openIds).toContain(idApprove);
      expect(openIds).toContain(idPaused);
      expect(openIds).not.toContain(idDone);
    });

    it('updateWorkItem returns incrementing version', async () => {
      const id = await store.createWorkItem('Versioned task', 'medium');
      const v1 = await store.updateWorkItem(id, { title: 'First update' });
      const v2 = await store.updateWorkItem(id, { title: 'Second update' });
      const v3 = await store.updateWorkItem(id, { title: 'Third update' });

      expect(v1).toBe(1);
      expect(v2).toBe(2);
      expect(v3).toBe(3);

      const item = await store.getWorkItem(id);
      expect(item!.version).toBe(3);
    });

    it('updateWorkItem with expectVersion succeeds when version matches', async () => {
      const id = await store.createWorkItem('Locked task', 'medium');
      const item = await store.getWorkItem(id);
      const next = await store.updateWorkItem(
        id,
        { title: 'Updated' },
        { expectVersion: item!.version }
      );
      expect(next).toBe(1);
    });

    it('updateWorkItem with expectVersion throws VersionConflictError when stale', async () => {
      const id = await store.createWorkItem('Conflict task', 'medium');
      const staleVersion = 0;
      // Concurrent update bumps version
      await store.updateWorkItem(id, { title: 'Concurrent update' });
      // Now stale version should fail
      await expect(
        store.updateWorkItem(id, { title: 'Stale update' }, { expectVersion: staleVersion })
      ).rejects.toThrow(/version conflict/);
    });

    it('updateWorkItem supports Phase 6b context mutation', async () => {
      const id = await store.createWorkItem('Context-mutated task', 'medium');
      await store.updateWorkItem(id, {
        goal: 'a new goal',
        context: { references: ['/tmp/a.txt'] },
        relatedSkills: ['skill-a', 'skill-b'],
        workerId: 'wkr-abc',
        leaseExpiresAt: '2030-01-01T00:00:00Z',
      });

      const item = await store.getWorkItem(id);
      expect(item!.goal).toBe('a new goal');
      expect(item!.context?.references).toEqual(['/tmp/a.txt']);
      expect(item!.relatedSkills).toEqual(['skill-a', 'skill-b']);
      expect(item!.workerId).toBe('wkr-abc');
      expect(item!.leaseExpiresAt).toBeTruthy();
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

  // --- Phase 5b tests ---

  describe('Phase 5b: temporal tracking', () => {
    it('invalidateFact sets valid_to', async () => {
      const id = await store.upsertFact('Temporal fact', 'general', ['test']);
      await store.invalidateFact(id);
      const facts = await store.getFacts();
      expect(facts.find((f) => f.id === id)).toBeUndefined(); // filtered out
      const history = await store.getFactHistory('Temporal fact', 'general');
      expect(history).toHaveLength(1);
      expect(history[0].validTo).toBeTruthy();
    });

    it('supersedeFact links old to new', async () => {
      const oldId = await store.upsertFact('Old fact', 'general', ['v1']);
      const newId = await store.upsertFact('New fact', 'general', ['v2']);
      await store.supersedeFact(oldId, newId);
      const facts = await store.getFacts();
      expect(facts.find((f) => f.id === oldId)).toBeUndefined();
      expect(facts.find((f) => f.id === newId)).toBeTruthy();
    });

    it('searchFacts filters out invalidated facts', async () => {
      const id = await store.upsertFact('Search test fact', 'technical', ['search']);
      await store.invalidateFact(id);
      const results = await store.searchFacts('Search test fact');
      expect(results.find((f) => f.id === id)).toBeUndefined();
    });
  });

  describe('Phase 5b: entities', () => {
    it('upsertEntity creates and deduplicates entities', async () => {
      const id1 = await store.upsertEntity('Alice', 'person');
      const id2 = await store.upsertEntity('alice', 'person'); // same canonical name
      expect(id1).toBe(id2);
      const entities = await store.getEntities('person');
      expect(entities).toHaveLength(1);
    });

    it('linkFactEntity and getRelatedFacts work', async () => {
      const factId1 = await store.upsertFact('Fact about Alice', 'personal', ['alice']);
      const factId2 = await store.upsertFact('Another fact about Alice', 'project', ['alice']);
      const entityId = await store.upsertEntity('Alice', 'person');
      await store.linkFactEntity(factId1, entityId);
      await store.linkFactEntity(factId2, entityId);

      const related = await store.getRelatedFacts(factId1);
      expect(related).toHaveLength(1);
      expect(related[0].id).toBe(factId2);
    });

    it('createEntityRelationship stores relationships', async () => {
      const srcId = await store.upsertEntity('Alice', 'person');
      const tgtId = await store.upsertEntity('Neura', 'project');
      await store.createEntityRelationship(srcId, tgtId, 'works_on');
      const rels = await store.getEntityRelationships(srcId);
      expect(rels).toHaveLength(1);
      expect(rels[0].relationship).toBe('works_on');
    });
  });

  describe('Phase 5b: hybrid search', () => {
    it('searchFactsHybrid returns results via BM25 text search', async () => {
      await store.upsertFact('React deployment on Vercel', 'technical', ['react', 'vercel']);
      // No embedding, so BM25 only path
      const results = await store.searchFactsHybrid('React deployment');
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0].content).toContain('React');
    });
  });

  describe('Phase 5b: timeline', () => {
    it('getTimeline returns fact creation events', async () => {
      await store.upsertFact('Timeline fact', 'general', ['timeline']);
      // Use wide range to avoid timezone/precision issues with PGlite TIMESTAMP
      const from = new Date('2000-01-01');
      const to = new Date('2099-01-01');
      const timeline = await store.getTimeline(from, to);
      expect(timeline.length).toBeGreaterThanOrEqual(1);
      expect(timeline.some((e) => e.type === 'fact_created' && e.content === 'Timeline fact')).toBe(
        true
      );
    });

    it('getTimeline returns invalidation events', async () => {
      const id = await store.upsertFact('Soon invalid', 'general', ['temp']);
      await store.invalidateFact(id);
      const from = new Date('2000-01-01');
      const to = new Date('2099-01-01');
      const timeline = await store.getTimeline(from, to);
      expect(timeline.some((e) => e.type === 'fact_invalidated')).toBe(true);
    });
  });

  describe('Phase 5b: memory stats', () => {
    it('getMemoryStats returns accurate counts', async () => {
      await store.upsertFact('Active fact', 'general', ['active']);
      const id = await store.upsertFact('Expired fact', 'technical', ['expired']);
      await store.invalidateFact(id);
      await store.upsertEntity('TestEntity', 'concept');

      const stats = await store.getMemoryStats();
      expect(stats.activeFacts).toBeGreaterThanOrEqual(1);
      expect(stats.expiredFacts).toBeGreaterThanOrEqual(1);
      expect(stats.totalEntities).toBeGreaterThanOrEqual(1);
      expect(stats.topCategories).toBeTruthy();
    });
  });

  describe('Phase 5b: tag path', () => {
    it('upsertFact stores tagPath when provided', async () => {
      await store.upsertFact(
        'Tagged fact',
        'technical',
        ['react'],
        undefined,
        0.8,
        undefined,
        'technical.react.hooks'
      );
      const facts = await store.getFacts({ category: 'technical' });
      const found = facts.find((f) => f.content === 'Tagged fact');
      expect(found).toBeTruthy();
      expect(found!.tagPath).toBe('technical.react.hooks');
    });

    it('upsertFact defaults tagPath to category', async () => {
      await store.upsertFact('Default tag fact', 'project', ['test']);
      const facts = await store.getFacts({ category: 'project' });
      const found = facts.find((f) => f.content === 'Default tag fact');
      expect(found).toBeTruthy();
      expect(found!.tagPath).toBe('project');
    });
  });

  describe('Phase 5b: transcript chunks', () => {
    it('insertTranscriptChunks stores chunks that are retrievable', async () => {
      const sessionId = await store.createSession('grok', 'gemini');
      await store.appendTranscript(sessionId, 'user', 'Hello there');
      await store.appendTranscript(sessionId, 'assistant', 'Hi! How can I help?');
      await store.appendTranscript(sessionId, 'user', 'Tell me about pricing');

      const embedding = new Array(3072).fill(0.1);
      await store.insertTranscriptChunks(sessionId, [
        {
          chunkText:
            'user: Hello there\nassistant: Hi! How can I help?\nuser: Tell me about pricing',
          embedding,
          startTranscriptId: 1,
          endTranscriptId: 3,
        },
      ]);

      const stats = await store.getMemoryStats();
      expect(stats.totalTranscriptsIndexed).toBe(1);
    });

    it('searchTranscripts returns chunk text not individual entries', async () => {
      const sessionId = await store.createSession('grok', 'gemini');
      await store.appendTranscript(sessionId, 'user', 'What about React hooks?');
      await store.appendTranscript(
        sessionId,
        'assistant',
        'React hooks let you use state in function components'
      );
      await store.appendTranscript(sessionId, 'user', 'Give me an example');

      const embedding = new Array(3072).fill(0.2);
      const chunkText =
        'user: What about React hooks?\nassistant: React hooks let you use state in function components\nuser: Give me an example';
      await store.insertTranscriptChunks(sessionId, [
        { chunkText, embedding, startTranscriptId: 1, endTranscriptId: 3 },
      ]);

      const results = await store.searchTranscripts(embedding, 5);
      expect(results).toHaveLength(1);
      expect(results[0].chunkText).toBe(chunkText);
      expect(results[0].sessionId).toBe(sessionId);
      expect(results[0].startTranscriptId).toBe(1);
      expect(results[0].endTranscriptId).toBe(3);
    });

    it('searchTranscripts filters by sessionId', async () => {
      const session1 = await store.createSession('grok', 'gemini');
      const session2 = await store.createSession('grok', 'gemini');

      const embedding = new Array(3072).fill(0.3);
      await store.insertTranscriptChunks(session1, [
        { chunkText: 'chunk from session 1', embedding, startTranscriptId: 1, endTranscriptId: 3 },
      ]);
      await store.insertTranscriptChunks(session2, [
        { chunkText: 'chunk from session 2', embedding, startTranscriptId: 4, endTranscriptId: 6 },
      ]);

      const results = await store.searchTranscripts(embedding, 10, session1);
      expect(results).toHaveLength(1);
      expect(results[0].chunkText).toBe('chunk from session 1');
    });
  });
});
