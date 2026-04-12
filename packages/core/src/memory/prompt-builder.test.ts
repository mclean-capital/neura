import { describe, it, expect } from 'vitest';
import type { MemoryContext } from '@neura/types';
import { buildMemoryPrompt } from './prompt-builder.js';

function makeContext(overrides: Partial<MemoryContext> = {}): MemoryContext {
  return {
    identity: [
      {
        id: '1',
        attribute: 'base_personality',
        value: 'You are Neura, a helpful voice assistant with camera and screen vision.',
        source: 'default',
        sourceSessionId: null,
        createdAt: '',
        updatedAt: '',
      },
      {
        id: '2',
        attribute: 'tone',
        value: 'direct and conversational',
        source: 'default',
        sourceSessionId: null,
        createdAt: '',
        updatedAt: '',
      },
      {
        id: '3',
        attribute: 'verbosity',
        value: 'concise — 1-2 sentences unless asked for detail',
        source: 'default',
        sourceSessionId: null,
        createdAt: '',
        updatedAt: '',
      },
    ],
    userProfile: [],
    recentFacts: [],
    preferences: [],
    recentSummaries: [],
    tokenEstimate: 0,
    ...overrides,
  };
}

describe('buildMemoryPrompt', () => {
  it('includes identity as opening lines', () => {
    const prompt = buildMemoryPrompt(makeContext());

    expect(prompt).toContain('You are Neura');
    expect(prompt).toContain('Tone: direct and conversational');
    expect(prompt).toContain('Verbosity: concise');
  });

  it('always includes tool instructions', () => {
    const prompt = buildMemoryPrompt(makeContext());

    expect(prompt).toContain('describe_camera');
    expect(prompt).toContain('describe_screen');
  });

  it('omits empty preference section', () => {
    const prompt = buildMemoryPrompt(makeContext({ preferences: [] }));
    expect(prompt).not.toContain('User preferences:');
  });

  it('includes preferences with strength emphasis', () => {
    const prompt = buildMemoryPrompt(
      makeContext({
        preferences: [
          {
            id: '1',
            preference: 'Be concise',
            category: 'response_style',
            strength: 1.0,
            sourceSessionId: null,
            reinforcementCount: 1,
            createdAt: '',
            updatedAt: '',
          },
          {
            id: '2',
            preference: 'Always explain reasoning',
            category: 'response_style',
            strength: 1.8,
            sourceSessionId: null,
            reinforcementCount: 5,
            createdAt: '',
            updatedAt: '',
          },
        ],
      })
    );

    expect(prompt).toContain('User preferences:');
    expect(prompt).toContain('- Be concise');
    expect(prompt).not.toContain('Be concise (strongly prefers)');
    expect(prompt).toContain('- Always explain reasoning (strongly prefers)');
  });

  it('includes user profile fields', () => {
    const prompt = buildMemoryPrompt(
      makeContext({
        userProfile: [
          {
            id: '1',
            field: 'name',
            value: 'Don',
            confidence: 0.9,
            sourceSessionId: null,
            createdAt: '',
            updatedAt: '',
          },
          {
            id: '2',
            field: 'role',
            value: 'founder',
            confidence: 0.8,
            sourceSessionId: null,
            createdAt: '',
            updatedAt: '',
          },
        ],
      })
    );

    expect(prompt).toContain('About the user:');
    expect(prompt).toContain('- Name: Don');
    expect(prompt).toContain('- Role: founder');
  });

  it('includes recent facts with category', () => {
    const prompt = buildMemoryPrompt(
      makeContext({
        recentFacts: [
          {
            id: '1',
            content: 'User prefers TypeScript',
            category: 'technical',
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
      })
    );

    expect(prompt).toContain('Things you know:');
    expect(prompt).toContain('- [technical] User prefers TypeScript');
  });

  it('includes session summaries with topics and threads', () => {
    const prompt = buildMemoryPrompt(
      makeContext({
        recentSummaries: [
          {
            id: '1',
            sessionId: 's1',
            summary: 'Discussed project architecture.',
            topics: ['architecture', 'database'],
            keyDecisions: [],
            openThreads: ['Worker system design'],
            extractionModel: 'adapter-text',
            extractionCostUsd: null,
            createdAt: '',
          },
        ],
      })
    );

    expect(prompt).toContain('Recent sessions:');
    expect(prompt).toContain('Discussed project architecture.');
    expect(prompt).toContain('Topics: architecture, database.');
    expect(prompt).toContain('Open threads: Worker system design.');
  });

  it('omits empty user profile, facts, and summaries sections', () => {
    const prompt = buildMemoryPrompt(makeContext());

    expect(prompt).not.toContain('About the user:');
    expect(prompt).not.toContain('Things you know:');
    expect(prompt).not.toContain('Recent sessions:');
  });

  it('handles full context with all sections', () => {
    const prompt = buildMemoryPrompt(
      makeContext({
        preferences: [
          {
            id: '1',
            preference: 'Short answers',
            category: 'response_style',
            strength: 1.0,
            sourceSessionId: null,
            reinforcementCount: 1,
            createdAt: '',
            updatedAt: '',
          },
        ],
        userProfile: [
          {
            id: '1',
            field: 'name',
            value: 'Don',
            confidence: 0.9,
            sourceSessionId: null,
            createdAt: '',
            updatedAt: '',
          },
        ],
        recentFacts: [
          {
            id: '1',
            content: 'Uses Neura daily',
            category: 'general',
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
        recentSummaries: [
          {
            id: '1',
            sessionId: 's1',
            summary: 'Quick check-in.',
            topics: [],
            keyDecisions: [],
            openThreads: [],
            extractionModel: 'adapter-text',
            extractionCostUsd: null,
            createdAt: '',
          },
        ],
      })
    );

    // All sections present
    expect(prompt).toContain('You are Neura');
    expect(prompt).toContain('describe_camera');
    expect(prompt).toContain('User preferences:');
    expect(prompt).toContain('About the user:');
    expect(prompt).toContain('Things you know:');
    expect(prompt).toContain('Recent sessions:');
  });
});
