import type { CostUpdateMessage, ProviderPricing } from '@neura/types';
import { SESSION_PRICING } from './providers/index.js';

export function createCostTracker(pricing: ProviderPricing = SESSION_PRICING) {
  const startTime = Date.now();
  const visionSources = {
    camera: { startTime: null as number | null, activeMs: 0 },
    screen: { startTime: null as number | null, activeMs: 0 },
  };
  let interval: ReturnType<typeof setInterval> | null = null;

  function markVisionActive(source: 'camera' | 'screen') {
    visionSources[source].startTime ??= Date.now();
  }

  function markVisionInactive(source: 'camera' | 'screen') {
    const s = visionSources[source];
    if (s.startTime) {
      s.activeMs += Date.now() - s.startTime;
      s.startTime = null;
    }
  }

  function getVisionMs(): number {
    const now = Date.now();
    let total = 0;
    for (const s of Object.values(visionSources)) {
      total += s.activeMs + (s.startTime ? now - s.startTime : 0);
    }
    return total;
  }

  function getUpdate(): CostUpdateMessage {
    const now = Date.now();
    const sessionDurationMs = now - startTime;
    const totalVisionMs = getVisionMs();

    const voiceCost = sessionDurationMs * pricing.voiceRatePerMs;
    const visionCost = totalVisionMs * pricing.visionRatePerMs;

    return {
      type: 'costUpdate',
      sessionDurationMs,
      estimatedCostUsd: voiceCost + visionCost,
      breakdown: {
        voice: voiceCost,
        vision: visionCost,
      },
    };
  }

  function startInterval(sendFn: (msg: CostUpdateMessage) => void, intervalMs: number) {
    stopInterval();
    interval = setInterval(() => {
      sendFn(getUpdate());
    }, intervalMs);
  }

  function stopInterval() {
    if (interval) {
      clearInterval(interval);
      interval = null;
    }
  }

  return { markVisionActive, markVisionInactive, getUpdate, startInterval, stopInterval };
}
