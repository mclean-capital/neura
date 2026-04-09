import { GoogleGenAI } from '@google/genai';
import { Logger } from '@neura/utils/logger';
import type { FactEntry } from '@neura/types';

const log = new Logger('reranker');

const RERANK_MODEL = 'gemini-2.5-flash';
const RERANK_TIMEOUT_MS = 3000;

export interface Reranker {
  rerank(query: string, candidates: FactEntry[], topN?: number): Promise<FactEntry[]>;
}

export function createReranker(googleApiKey: string): Reranker {
  const ai = new GoogleGenAI({ apiKey: googleApiKey });

  async function rerank(query: string, candidates: FactEntry[], topN = 10): Promise<FactEntry[]> {
    if (candidates.length <= topN) return candidates;

    try {
      const prompt = `Given this query: "${query}"

Rank these memory entries by relevance (most relevant first).
Return ONLY a JSON array of indices (0-based) in order of relevance.

Entries:
${candidates.map((f, i) => `[${i}] ${f.content} (${f.category})`).join('\n')}`;

      const apiCall = ai.models.generateContent({
        model: RERANK_MODEL,
        contents: prompt,
        config: {
          responseMimeType: 'application/json',
        },
      });

      const timeoutPromise = new Promise<null>((resolve) =>
        setTimeout(() => resolve(null), RERANK_TIMEOUT_MS)
      );

      const response = await Promise.race([apiCall, timeoutPromise]);
      if (!response) {
        log.warn('rerank timed out, returning candidates as-is');
        return candidates.slice(0, topN);
      }

      const text = response.text;
      if (!text) {
        log.warn('empty rerank response, returning candidates as-is');
        return candidates.slice(0, topN);
      }

      const indices: number[] = JSON.parse(text);
      const valid = indices.filter((i) => i >= 0 && i < candidates.length);
      return valid.slice(0, topN).map((i) => candidates[i]);
    } catch (err) {
      log.warn('reranking failed, returning candidates as-is', { err: String(err) });
      return candidates.slice(0, topN);
    }
  }

  return { rerank };
}
