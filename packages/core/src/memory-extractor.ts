import { GoogleGenAI } from '@google/genai';
import { Logger } from '@neura/utils/logger';
import type { TranscriptEntry, MemoryContext, ExtractionResult } from '@neura/types';

const log = new Logger('extractor');

const EXTRACTION_MODEL = 'gemini-2.5-flash';
const EMBEDDING_MODEL = 'gemini-embedding-2-preview';
const MIN_TRANSCRIPT_ENTRIES = 4;

export interface ExtractionOutput {
  result: ExtractionResult;
  factEmbeddings: (number[] | null)[];
}

export interface ExtractionPipeline {
  extract(
    transcript: TranscriptEntry[],
    existingContext: MemoryContext
  ): Promise<ExtractionOutput | null>;

  generateEmbedding(text: string): Promise<number[] | null>;
}

const EXTRACTION_PROMPT = `You are a memory extraction agent. Analyze the conversation transcript and extract structured information. Return JSON only.

Extract:
1. facts — Durable knowledge that would be true tomorrow. Include category (project, technical, business, personal, general) and tags.
2. preferences — Behavioral instructions from user feedback about how the AI should behave.
3. userProfile — Who the user is (name, role, company, expertise, location, etc).
4. identityUpdates — Changes to how the AI should behave (tone, verbosity, personality).
5. sessionSummary — 2-4 sentence summary, topics discussed, key decisions made, open threads.

Rules:
- Only extract durable facts. Not "it's raining" but "user lives in Seattle."
- Deduplicate against existing context provided below.
- Empty arrays for categories with no extractions.
- For sessionSummary, always provide summary and topics even if minimal.`;

const EXTRACTION_SCHEMA = {
  type: 'object' as const,
  properties: {
    facts: {
      type: 'array' as const,
      items: {
        type: 'object' as const,
        properties: {
          content: { type: 'string' as const },
          category: { type: 'string' as const },
          tags: { type: 'array' as const, items: { type: 'string' as const } },
        },
        required: ['content', 'category', 'tags'] as const,
      },
    },
    preferences: {
      type: 'array' as const,
      items: {
        type: 'object' as const,
        properties: {
          preference: { type: 'string' as const },
          category: { type: 'string' as const },
        },
        required: ['preference', 'category'] as const,
      },
    },
    userProfile: {
      type: 'array' as const,
      items: {
        type: 'object' as const,
        properties: {
          field: { type: 'string' as const },
          value: { type: 'string' as const },
        },
        required: ['field', 'value'] as const,
      },
    },
    identityUpdates: {
      type: 'array' as const,
      items: {
        type: 'object' as const,
        properties: {
          attribute: { type: 'string' as const },
          value: { type: 'string' as const },
        },
        required: ['attribute', 'value'] as const,
      },
    },
    sessionSummary: {
      type: 'object' as const,
      properties: {
        summary: { type: 'string' as const },
        topics: { type: 'array' as const, items: { type: 'string' as const } },
        keyDecisions: { type: 'array' as const, items: { type: 'string' as const } },
        openThreads: { type: 'array' as const, items: { type: 'string' as const } },
      },
      required: ['summary', 'topics', 'keyDecisions', 'openThreads'] as const,
    },
  },
  required: ['facts', 'preferences', 'userProfile', 'identityUpdates', 'sessionSummary'] as const,
};

function formatTranscript(transcript: TranscriptEntry[]): string {
  return transcript.map((t) => `${t.role}: ${t.text}`).join('\n');
}

function formatExistingContext(context: MemoryContext): string {
  const parts: string[] = [];

  if (context.recentFacts.length > 0) {
    parts.push('Known facts: ' + context.recentFacts.map((f) => f.content).join('; '));
  }
  if (context.userProfile.length > 0) {
    parts.push(
      'User profile: ' + context.userProfile.map((p) => `${p.field}=${p.value}`).join(', ')
    );
  }
  if (context.preferences.length > 0) {
    parts.push('Preferences: ' + context.preferences.map((p) => p.preference).join('; '));
  }

  return parts.length > 0 ? parts.join('\n') : 'No existing context.';
}

export function createExtractionPipeline(googleApiKey: string): ExtractionPipeline {
  const ai = new GoogleGenAI({ apiKey: googleApiKey });

  async function generateEmbedding(text: string): Promise<number[] | null> {
    try {
      const response = await ai.models.embedContent({
        model: EMBEDDING_MODEL,
        contents: text,
      });
      const values = response.embeddings?.[0]?.values;
      if (values?.length === 3072) return values;
      log.warn('unexpected embedding dimensions', { length: values?.length });
      return null;
    } catch (err) {
      log.warn('embedding generation failed', { err: String(err) });
      return null;
    }
  }

  async function extract(
    transcript: TranscriptEntry[],
    existingContext: MemoryContext
  ): Promise<ExtractionOutput | null> {
    if (transcript.length < MIN_TRANSCRIPT_ENTRIES) {
      log.info('transcript too short for extraction', { entries: transcript.length });
      return null;
    }

    try {
      const formattedTranscript = formatTranscript(transcript);
      const contextRef = formatExistingContext(existingContext);

      const response = await ai.models.generateContent({
        model: EXTRACTION_MODEL,
        contents: `Existing context (for deduplication):\n${contextRef}\n\nTranscript:\n${formattedTranscript}`,
        config: {
          systemInstruction: EXTRACTION_PROMPT,
          responseMimeType: 'application/json',
          responseSchema: EXTRACTION_SCHEMA,
        },
      });

      const text = response.text;
      if (!text) {
        log.warn('empty extraction response');
        return null;
      }

      const result = JSON.parse(text) as ExtractionResult;

      // Generate embeddings for each extracted fact (parallel)
      const factEmbeddings = await Promise.all(
        result.facts.map((fact) => generateEmbedding(fact.content))
      );

      log.info('extraction complete', {
        facts: result.facts.length,
        preferences: result.preferences.length,
        profileUpdates: result.userProfile.length,
        identityUpdates: result.identityUpdates.length,
      });

      return { result, factEmbeddings };
    } catch (err) {
      log.error('extraction failed', { err: String(err) });
      return null;
    }
  }

  return { extract, generateEmbedding };
}
