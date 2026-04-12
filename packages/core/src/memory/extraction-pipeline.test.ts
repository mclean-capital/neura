import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { TranscriptEntry, MemoryContext, TextAdapter, EmbeddingAdapter } from '@neura/types';

import { ExtractionPipeline } from './extraction-pipeline.js';

const mockChat = vi.fn();
const mockEmbed = vi.fn();

const mockTextAdapter: TextAdapter = {
  chat: mockChat,
  chatStream: vi.fn(),
  chatWithTools: vi.fn(),
  chatWithToolsStream: vi.fn(),
  close: vi.fn(),
};

const mockEmbeddingAdapter: EmbeddingAdapter = {
  embed: mockEmbed,
  dimensions: () => 3072,
  close: vi.fn(),
};

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

describe('ExtractionPipeline', () => {
  describe('extract', () => {
    it('returns null for short transcripts', async () => {
      const pipeline = new ExtractionPipeline(mockTextAdapter, mockEmbeddingAdapter);
      const result = await pipeline.extract(makeTranscript(3), emptyContext);
      expect(result).toBeNull();
      expect(mockChat).not.toHaveBeenCalled();
    });

    it('extracts structured data from transcript', async () => {
      mockChat.mockResolvedValue({
        content: JSON.stringify(sampleExtraction),
      });
      mockEmbed.mockResolvedValue([new Array(3072).fill(0.1)]);

      const pipeline = new ExtractionPipeline(mockTextAdapter, mockEmbeddingAdapter);
      const output = await pipeline.extract(makeTranscript(6), emptyContext);

      expect(output).not.toBeNull();
      expect(output!.result.facts).toHaveLength(2);
      expect(output!.result.facts[0].content).toBe('User lives in Seattle');
      expect(output!.result.preferences).toHaveLength(1);
      expect(output!.result.userProfile).toHaveLength(1);
      expect(output!.result.sessionSummary.summary).toContain('project setup');
    });

    it('generates embeddings for each extracted fact', async () => {
      mockChat.mockResolvedValue({
        content: JSON.stringify(sampleExtraction),
      });
      mockEmbed.mockResolvedValue([new Array(3072).fill(0.5)]);

      const pipeline = new ExtractionPipeline(mockTextAdapter, mockEmbeddingAdapter);
      const output = await pipeline.extract(makeTranscript(6), emptyContext);

      expect(output!.factEmbeddings).toHaveLength(2);
      expect(output!.factEmbeddings[0]).toHaveLength(3072);
      // 2 fact embeddings + 3 overlapping transcript chunks (6 entries, step=2: [0,1,2] [2,3,4] [4,5])
      expect(mockEmbed).toHaveBeenCalledTimes(5);
    });

    it('handles malformed JSON response gracefully', async () => {
      mockChat.mockResolvedValue({
        content: 'not valid json {{{',
      });

      const pipeline = new ExtractionPipeline(mockTextAdapter, mockEmbeddingAdapter);
      const output = await pipeline.extract(makeTranscript(6), emptyContext);

      expect(output).toBeNull();
    });

    it('handles API failure gracefully', async () => {
      mockChat.mockRejectedValue(new Error('API rate limit'));

      const pipeline = new ExtractionPipeline(mockTextAdapter, mockEmbeddingAdapter);
      const output = await pipeline.extract(makeTranscript(6), emptyContext);

      expect(output).toBeNull();
    });

    it('handles empty response text as failure', async () => {
      mockChat.mockResolvedValue({ content: '' });

      const pipeline = new ExtractionPipeline(mockTextAdapter, mockEmbeddingAdapter);
      const output = await pipeline.extract(makeTranscript(6), emptyContext);

      expect(output).toBeNull();
    });

    it('handles embedding failure without blocking extraction', async () => {
      mockChat.mockResolvedValue({
        content: JSON.stringify(sampleExtraction),
      });
      mockEmbed.mockRejectedValue(new Error('embedding API down'));

      const pipeline = new ExtractionPipeline(mockTextAdapter, mockEmbeddingAdapter);
      const output = await pipeline.extract(makeTranscript(6), emptyContext);

      expect(output!.result.facts).toHaveLength(2);
      expect(output!.factEmbeddings).toHaveLength(2);
      expect(output!.factEmbeddings[0]).toBeNull();
      expect(output!.factEmbeddings[1]).toBeNull();
    });

    it('includes existing context for deduplication', async () => {
      mockChat.mockResolvedValue({
        content: JSON.stringify({ ...sampleExtraction, facts: [] }),
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

      const pipeline = new ExtractionPipeline(mockTextAdapter, mockEmbeddingAdapter);
      await pipeline.extract(makeTranscript(6), contextWithFacts);

      // Check that the user message contains existing context
      const call = mockChat.mock.calls[0][0];
      const userMsg = call.find((m: { role: string }) => m.role === 'user');
      expect(userMsg.content).toContain('User lives in Seattle');
    });
  });

  describe('generateEmbedding', () => {
    it('returns embedding vector on success', async () => {
      mockEmbed.mockResolvedValue([new Array(3072).fill(0.1)]);

      const pipeline = new ExtractionPipeline(mockTextAdapter, mockEmbeddingAdapter);
      const embedding = await pipeline.generateEmbedding('test text');

      expect(embedding).toHaveLength(3072);
    });

    it('returns null on failure', async () => {
      mockEmbed.mockRejectedValue(new Error('API error'));

      const pipeline = new ExtractionPipeline(mockTextAdapter, mockEmbeddingAdapter);
      const embedding = await pipeline.generateEmbedding('test text');

      expect(embedding).toBeNull();
    });
  });
});
