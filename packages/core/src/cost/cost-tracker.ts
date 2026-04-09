import type { CostUpdateMessage, ProviderPricing } from '@neura/types';
import { SESSION_PRICING } from '../providers/index.js';

export class CostTracker {
  private readonly pricing: ProviderPricing;
  private readonly startTime: number;
  private readonly visionSources: {
    camera: { startTime: number | null; activeMs: number };
    screen: { startTime: number | null; activeMs: number };
  };
  private interval: ReturnType<typeof setInterval> | null = null;

  constructor(pricing: ProviderPricing = SESSION_PRICING) {
    this.pricing = pricing;
    this.startTime = Date.now();
    this.visionSources = {
      camera: { startTime: null, activeMs: 0 },
      screen: { startTime: null, activeMs: 0 },
    };
  }

  markVisionActive(source: 'camera' | 'screen'): void {
    this.visionSources[source].startTime ??= Date.now();
  }

  markVisionInactive(source: 'camera' | 'screen'): void {
    const s = this.visionSources[source];
    if (s.startTime) {
      s.activeMs += Date.now() - s.startTime;
      s.startTime = null;
    }
  }

  private getVisionMs(): number {
    const now = Date.now();
    let total = 0;
    for (const s of Object.values(this.visionSources)) {
      total += s.activeMs + (s.startTime ? now - s.startTime : 0);
    }
    return total;
  }

  getUpdate(): CostUpdateMessage {
    const now = Date.now();
    const sessionDurationMs = now - this.startTime;
    const totalVisionMs = this.getVisionMs();

    const voiceCost = sessionDurationMs * this.pricing.voiceRatePerMs;
    const visionCost = totalVisionMs * this.pricing.visionRatePerMs;

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

  startInterval(sendFn: (msg: CostUpdateMessage) => void, intervalMs: number): void {
    this.stopInterval();
    this.interval = setInterval(() => {
      sendFn(this.getUpdate());
    }, intervalMs);
  }

  stopInterval(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }
}
