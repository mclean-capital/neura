import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FactEntry, TextAdapter } from '@neura/types';

import { Reranker } from './reranker.js';

const mockChat = vi.fn();

const mockTextAdapter: TextAdapter = {
  chat: mockChat,
  chatStream: vi.fn(),
  chatWithTools: vi.fn(),
  chatWithToolsStream: vi.fn(),
  close: vi.fn(),
};

function makeFact(id: string, content: string, category = 'general'): FactEntry {
  return {
    id,
    content,
    category: category as FactEntry['category'],
    tags: [],
    sourceSessionId: null,
    confidence: 0.8,
    accessCount: 0,
    lastAccessedAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    expiresAt: null,
  };
}

describe('Reranker', () => {
  const reranker = new Reranker(mockTextAdapter);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns candidates as-is when count <= topN', async () => {
    const candidates = [makeFact('1', 'fact one'), makeFact('2', 'fact two')];
    const result = await reranker.rerank('query', candidates, 5);
    expect(result).toEqual(candidates);
    expect(mockChat).not.toHaveBeenCalled();
  });

  it('reranks candidates based on LLM-provided indices', async () => {
    mockChat.mockResolvedValue({ content: '[2, 0, 1]' });

    const candidates = [
      makeFact('a', 'low relevance'),
      makeFact('b', 'medium relevance'),
      makeFact('c', 'high relevance'),
    ];
    const result = await reranker.rerank('query', candidates, 2);

    expect(result).toHaveLength(2);
    expect(result[0].id).toBe('c');
    expect(result[1].id).toBe('a');
  });

  it('filters out-of-bounds indices', async () => {
    mockChat.mockResolvedValue({ content: '[0, 99, -1, 1]' });

    const candidates = [makeFact('a', 'first'), makeFact('b', 'second'), makeFact('c', 'third')];
    const result = await reranker.rerank('query', candidates, 2);

    expect(result).toHaveLength(2);
    expect(result[0].id).toBe('a');
    expect(result[1].id).toBe('b');
  });

  it('returns candidates as-is on API failure', async () => {
    mockChat.mockRejectedValue(new Error('API error'));

    const candidates = [makeFact('a', 'first'), makeFact('b', 'second'), makeFact('c', 'third')];
    const result = await reranker.rerank('query', candidates, 2);

    expect(result).toHaveLength(2);
    expect(result[0].id).toBe('a');
    expect(result[1].id).toBe('b');
  });

  it('returns candidates as-is on empty response', async () => {
    mockChat.mockResolvedValue({ content: '' });

    const candidates = [makeFact('a', 'first'), makeFact('b', 'second'), makeFact('c', 'third')];
    const result = await reranker.rerank('query', candidates, 2);
    expect(result).toHaveLength(2);
  });

  it('returns candidates as-is on malformed JSON response', async () => {
    mockChat.mockResolvedValue({ content: 'not json' });

    const candidates = [makeFact('a', 'first'), makeFact('b', 'second'), makeFact('c', 'third')];
    const result = await reranker.rerank('query', candidates, 2);
    expect(result).toHaveLength(2);
  });

  it('returns candidates as-is when API call exceeds timeout', async () => {
    // Simulate a long-running API call that exceeds the 3s timeout
    mockChat.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve({ content: '[2, 0, 1]' }), 10000))
    );

    const candidates = [makeFact('a', 'first'), makeFact('b', 'second'), makeFact('c', 'third')];
    const result = await reranker.rerank('query', candidates, 2);

    // Should return first 2 candidates as-is (timeout fallback)
    expect(result).toHaveLength(2);
    expect(result[0].id).toBe('a');
    expect(result[1].id).toBe('b');
  }, 10000); // Extend test timeout
});
