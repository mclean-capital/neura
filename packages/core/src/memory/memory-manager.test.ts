import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock @google/genai before importing memory-manager (which imports memory-extractor)
const mockGenerateContent = vi.fn();
const mockEmbedContent = vi.fn();

vi.mock('@google/genai', () => {
  return {
    GoogleGenAI: class MockGoogleGenAI {
      models = {
        generateContent: mockGenerateContent,
        embedContent: mockEmbedContent,
      };
    },
  };
});

import { PgliteStore } from '../stores/pglite-store.js';
import { MemoryManager } from './memory-manager.js';

let store: PgliteStore;

beforeEach(async () => {
  vi.clearAllMocks();
  store = await PgliteStore.create(); // in-memory

  // Default: embedding returns 3072-dim vector
  mockEmbedContent.mockResolvedValue({
    embeddings: [{ values: new Array(3072).fill(0.1) }],
  });
});

afterEach(async () => {
  await store.close();
});

describe('MemoryManager', () => {
  describe('buildSystemPrompt', () => {
    it('returns a non-empty prompt with identity', async () => {
      const manager = new MemoryManager({ store, googleApiKey: 'test-key' });
      const prompt = await manager.buildSystemPrompt();

      expect(prompt).toContain('Neura');
      expect(prompt).toContain('describe_camera');
      expect(prompt.length).toBeGreaterThan(100);
    });

    it('includes stored user profile in prompt', async () => {
      await store.upsertUserProfile('name', 'Don', 0.9);
      await store.upsertFact('User likes TypeScript', 'technical', []);

      const manager = new MemoryManager({ store, googleApiKey: 'test-key' });
      const prompt = await manager.buildSystemPrompt();

      expect(prompt).toContain('Don');
      expect(prompt).toContain('TypeScript');
    });
  });

  describe('storeFact', () => {
    it('generates embedding and persists fact', async () => {
      const manager = new MemoryManager({ store, googleApiKey: 'test-key' });
      const id = await manager.storeFact('User lives in Seattle', 'personal', ['location']);

      expect(id).toBeTruthy();
      expect(mockEmbedContent).toHaveBeenCalledOnce();

      const facts = await store.getFacts();
      expect(facts).toHaveLength(1);
      expect(facts[0].content).toBe('User lives in Seattle');
    });

    it('stores fact even if embedding fails', async () => {
      mockEmbedContent.mockRejectedValue(new Error('API down'));

      const manager = new MemoryManager({ store, googleApiKey: 'test-key' });
      const id = await manager.storeFact('Important fact', 'general', []);

      expect(id).toBeTruthy();
      const facts = await store.getFacts();
      expect(facts).toHaveLength(1);
    });
  });

  describe('recall', () => {
    it('searches facts with vector embedding', async () => {
      // Store a fact with embedding
      await store.upsertFact(
        'User prefers dark mode',
        'technical',
        [],
        undefined,
        0.8,
        new Array(3072).fill(0.5)
      );

      const manager = new MemoryManager({ store, googleApiKey: 'test-key' });
      const results = await manager.recall('dark theme');

      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0].content).toBe('User prefers dark mode');
    });

    it('falls back to text search if embedding fails', async () => {
      mockEmbedContent.mockRejectedValue(new Error('API down'));

      await store.upsertFact('User lives in Seattle', 'personal', []);

      const manager = new MemoryManager({ store, googleApiKey: 'test-key' });
      const results = await manager.recall('Seattle');

      expect(results).toHaveLength(1);
      expect(results[0].content).toBe('User lives in Seattle');
    });
  });

  describe('storePreference', () => {
    it('stores a preference', async () => {
      const manager = new MemoryManager({ store, googleApiKey: 'test-key' });
      await manager.storePreference('Be more concise', 'response_style');

      const prefs = await store.getPreferences();
      expect(prefs).toHaveLength(1);
      expect(prefs[0].preference).toBe('Be more concise');
    });
  });

  describe('queueExtraction', () => {
    it('skips extraction for short transcripts', async () => {
      const sessionId = await store.createSession('grok', 'gemini');
      await store.appendTranscript(sessionId, 'user', 'Hello');
      await store.appendTranscript(sessionId, 'assistant', 'Hi');

      const manager = new MemoryManager({ store, googleApiKey: 'test-key' });
      await manager.queueExtraction(sessionId);

      // No extraction record should be created
      expect(mockGenerateContent).not.toHaveBeenCalled();
    });

    it('extracts and stores data from sufficient transcript', async () => {
      const sessionId = await store.createSession('grok', 'gemini');
      await store.appendTranscript(sessionId, 'user', 'My name is Don');
      await store.appendTranscript(sessionId, 'assistant', 'Nice to meet you, Don!');
      await store.appendTranscript(sessionId, 'user', 'I live in Seattle');
      await store.appendTranscript(sessionId, 'assistant', 'Seattle is a great city!');
      await store.appendTranscript(sessionId, 'user', 'I prefer concise responses');
      await store.appendTranscript(sessionId, 'assistant', 'Got it, I will be concise.');

      mockGenerateContent.mockResolvedValue({
        text: JSON.stringify({
          facts: [{ content: 'User lives in Seattle', category: 'personal', tags: ['location'] }],
          preferences: [{ preference: 'Be concise', category: 'response_style' }],
          userProfile: [{ field: 'name', value: 'Don' }],
          identityUpdates: [],
          sessionSummary: {
            summary: 'Introduction and preferences discussion.',
            topics: ['introduction'],
            keyDecisions: [],
            openThreads: [],
          },
        }),
      });

      const manager = new MemoryManager({ store, googleApiKey: 'test-key' });
      await manager.queueExtraction(sessionId);

      // Verify extracted data was stored
      const facts = await store.getFacts();
      expect(facts.some((f) => f.content === 'User lives in Seattle')).toBe(true);

      const prefs = await store.getPreferences();
      expect(prefs.some((p) => p.preference === 'Be concise')).toBe(true);

      const profile = await store.getUserProfile();
      expect(profile.some((p) => p.field === 'name' && p.value === 'Don')).toBe(true);

      const summary = await store.getSessionSummary(sessionId);
      expect(summary).not.toBeNull();
      expect(summary!.summary).toContain('Introduction');
    });

    it('handles extraction API failure gracefully', async () => {
      const sessionId = await store.createSession('grok', 'gemini');
      for (let i = 0; i < 6; i++) {
        await store.appendTranscript(sessionId, i % 2 === 0 ? 'user' : 'assistant', `msg ${i}`);
      }

      mockGenerateContent.mockRejectedValue(new Error('API rate limit'));

      const manager = new MemoryManager({ store, googleApiKey: 'test-key' });

      // Should not throw
      await expect(manager.queueExtraction(sessionId)).resolves.not.toThrow();
    });
  });

  describe('close', () => {
    it('resolves when no pending extractions', async () => {
      const manager = new MemoryManager({ store, googleApiKey: 'test-key' });
      await expect(manager.close()).resolves.not.toThrow();
    });
  });
});
