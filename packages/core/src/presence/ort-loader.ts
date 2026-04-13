/**
 * Dynamic ONNX runtime loader with native → WASM fallback.
 *
 * Tries onnxruntime-node (native CPU bindings) first. If the platform
 * doesn't have native binaries — e.g. Intel Macs after onnxruntime 1.24
 * dropped darwin/x64 — falls back to onnxruntime-web's WASM backend,
 * which works on any platform Node.js runs on.
 *
 * Returns null if neither runtime is available.
 */

import type * as OrtNamespace from 'onnxruntime-node';
import { Logger } from '@neura/utils/logger';

const log = new Logger('ort-loader');

/** The full onnxruntime module shape (both -node and -web export this). */
export type OrtModule = typeof OrtNamespace;

/** Which backend resolved at runtime. */
export type OrtBackend = 'native' | 'wasm';

export interface OrtLoadResult {
  ort: OrtModule;
  backend: OrtBackend;
}

let cached: OrtLoadResult | null | undefined;

/**
 * Load the best available ONNX runtime. Result is cached after first call.
 *
 * - `native` — onnxruntime-node with CPU execution provider (~5-20ms inference)
 * - `wasm`   — onnxruntime-web with WASM backend (~50-300ms inference)
 * - `null`   — neither runtime available; caller should disable ONNX features
 */
export async function loadOrt(): Promise<OrtLoadResult | null> {
  if (cached !== undefined) return cached;

  // 1. Native (onnxruntime-node)
  try {
    const mod = await import('onnxruntime-node');
    cached = { ort: mod, backend: 'native' };
    log.info('ONNX runtime loaded', { backend: 'native' });
    return cached;
  } catch {
    log.debug('onnxruntime-node unavailable, trying WASM fallback');
  }

  // 2. WASM fallback (onnxruntime-web)
  try {
    const mod = (await import('onnxruntime-web')) as unknown as OrtModule;
    // Node.js WASM threading defaults changed in ort 1.19+ and can cause
    // worker-thread failures — force single-threaded for reliability.
    mod.env.wasm.numThreads = 1;
    cached = { ort: mod, backend: 'wasm' };
    log.info('ONNX runtime loaded', { backend: 'wasm' });
    return cached;
  } catch {
    log.warn('no ONNX runtime available — wake word detection will be disabled');
  }

  cached = null;
  return null;
}
