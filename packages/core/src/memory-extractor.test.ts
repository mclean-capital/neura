import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { TranscriptEntry, MemoryContext } from '@neura/types';

// Mock @google/genai
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

import { createExtractionPipeline } from './memory-extractor.js';

const emptyContext: MemoryContext = {
  identity: [],
  userProfile: [],
  recentFacts: [],
  preferences: [],
  recentSummaries: [],
  tokenEstimate: 0,
};

function makeTranscript(count: number): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  for (let i = 0; i < count; i++) {
    entries.push({
      id: i + 1,
      sessionId: 'test-session',
      role: i % 2 === 0 ? 'user' : 'assistant',
      text: `Message ${i + 1}`,
      createdAt: new Date().toISOString(),
    });
  }
  return entries;
}

const sampleExtraction = {
  facts: [
    { content: 'User lives in Seattle', category: 'personal', tags: ['location'] },
    { content: 'User uses TypeScript', category: 'technical', tags: ['language'] },
  ],
  preferences: [{ preference: 'Be concise', category: 'response_style' }],
  userProfile: [{ field: 'name', value: 'Don' }],
  identityUpdates: [],
  sessionSummary: {
    summary: 'Discussed project setup and preferences.',
    topics: ['setup', 'preferences'],
    keyDecisions: ['Use TypeScript'],
    openThreads: ['Database design'],
  },
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('createExtractionPipeline', () => {
  describe('extract', () => {
    it('returns null for short transcripts', async () => {
      const pipeline = createExtractionPipeline('test-key');
      const result = await pipeline.extract(makeTranscript(3), emptyContext);
      expect(result).toBeNull();
      expect(mockGenerateContent).not.toHaveBeenCalled();
    });

    it('extracts structured data from transcript', async () => {
      mockGenerateContent.mockResolvedValue({
        text: JSON.stringify(sampleExtraction),
      });
      mockEmbedContent.mockResolvedValue({
        embeddings: [{ values: new Array(3072).fill(0.1) }],
      });

      const pipeline = createExtractionPipeline('test-key');
      const output = await pipeline.extract(makeTranscript(6), emptyContext);

      expect(output).not.toBeNull();
      expect(output!.result.facts).toHaveLength(2);
      expect(output!.result.facts[0].content).toBe('User lives in Seattle');
      expect(output!.result.preferences).toHaveLength(1);
      expect(output!.result.userProfile).toHaveLength(1);
      expect(output!.result.sessionSummary.summary).toContain('project setup');
    });

    it('generates embeddings for each extracted fact', async () => {
      mockGenerateContent.mockResolvedValue({
        text: JSON.stringify(sampleExtraction),
      });
      mockEmbedContent.mockResolvedValue({
        embeddings: [{ values: new Array(3072).fill(0.5) }],
      });

      const pipeline = createExtractionPipeline('test-key');
      const output = await pipeline.extract(makeTranscript(6), emptyContext);

      expect(output!.factEmbeddings).toHaveLength(2);
      expect(output!.factEmbeddings[0]).toHaveLength(3072);
      // 2 fact embeddings + 2 transcript chunk embeddings (6 entries / chunk size 3 = 2 chunks)
      expect(mockEmbedContent).toHaveBeenCalledTimes(4);
    });

    it('handles malformed JSON response gracefully', async () => {
      mockGenerateContent.mockResolvedValue({
        text: 'not valid json {{{',
      });

      const pipeline = createExtractionPipeline('test-key');
      const output = await pipeline.extract(makeTranscript(6), emptyContext);

      expect(output).toBeNull();
    });

    it('handles API failure gracefully', async () => {
      mockGenerateContent.mockRejectedValue(new Error('API rate limit'));

      const pipeline = createExtractionPipeline('test-key');
      const output = await pipeline.extract(makeTranscript(6), emptyContext);

      expect(output).toBeNull();
    });

    it('handles empty response text as failure', async () => {
      mockGenerateContent.mockResolvedValue({ text: null });

      const pipeline = createExtractionPipeline('test-key');
      const output = await pipeline.extract(makeTranscript(6), emptyContext);

      expect(output).toBeNull();
    });

    it('handles embedding failure without blocking extraction', async () => {
      mockGenerateContent.mockResolvedValue({
        text: JSON.stringify(sampleExtraction),
      });
      mockEmbedContent.mockRejectedValue(new Error('embedding API down'));

      const pipeline = createExtractionPipeline('test-key');
      const output = await pipeline.extract(makeTranscript(6), emptyContext);

      expect(output!.result.facts).toHaveLength(2);
      expect(output!.factEmbeddings).toHaveLength(2);
      expect(output!.factEmbeddings[0]).toBeNull();
      expect(output!.factEmbeddings[1]).toBeNull();
    });

    it('includes existing context for deduplication', async () => {
      mockGenerateContent.mockResolvedValue({
        text: JSON.stringify({ ...sampleExtraction, facts: [] }),
      });

      const contextWithFacts: MemoryContext = {
        ...emptyContext,
        recentFacts: [
          {
            id: '1',
            content: 'User lives in Seattle',
            category: 'personal',
            tags: [],
            sourceSessionId: null,
            confidence: 0.8,
            accessCount: 0,
            lastAccessedAt: null,
            createdAt: '',
            updatedAt: '',
            expiresAt: null,
          },
        ],
      };

      const pipeline = createExtractionPipeline('test-key');
      await pipeline.extract(makeTranscript(6), contextWithFacts);

      const call = mockGenerateContent.mock.calls[0][0];
      expect(call.contents).toContain('User lives in Seattle');
    });
  });

  describe('generateEmbedding', () => {
    it('returns 3072-dim vector on success', async () => {
      mockEmbedContent.mockResolvedValue({
        embeddings: [{ values: new Array(3072).fill(0.1) }],
      });

      const pipeline = createExtractionPipeline('test-key');
      const embedding = await pipeline.generateEmbedding('test text');

      expect(embedding).toHaveLength(3072);
    });

    it('returns null on failure', async () => {
      mockEmbedContent.mockRejectedValue(new Error('API error'));

      const pipeline = createExtractionPipeline('test-key');
      const embedding = await pipeline.generateEmbedding('test text');

      expect(embedding).toBeNull();
    });

    it('returns null for unexpected dimensions', async () => {
      mockEmbedContent.mockResolvedValue({
        embeddings: [{ values: new Array(768).fill(0.1) }],
      });

      const pipeline = createExtractionPipeline('test-key');
      const embedding = await pipeline.generateEmbedding('test text');

      expect(embedding).toBeNull();
    });
  });
});
