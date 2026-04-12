import OpenAI from 'openai';
import type { EmbeddingAdapter, RouteDescriptor } from '@neura/types';

/**
 * Embedding adapter using the OpenAI-compatible embeddings API.
 * Works with: OpenAI, OpenRouter, xAI, and any provider that exposes
 * an OpenAI-compatible /v1/embeddings endpoint.
 */
export class OpenAICompatibleEmbeddingAdapter implements EmbeddingAdapter {
  private readonly client: OpenAI;
  private readonly model: string;
  private readonly dims: number;

  constructor(route: RouteDescriptor & { dimensions: number }) {
    this.client = new OpenAI({
      apiKey: route.apiKey,
      baseURL: route.baseUrl,
    });
    this.model = route.model;
    this.dims = route.dimensions;
  }

  async embed(texts: string[]): Promise<number[][]> {
    const res = await this.client.embeddings.create({
      model: this.model,
      input: texts,
      dimensions: this.dims,
    });
    // Sort by index to ensure order matches input
    return res.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
  }

  dimensions(): number {
    return this.dims;
  }

  close(): void {
    // OpenAI client has no persistent connections to close
  }
}
