import type { CostUpdateMessage } from '@neura/shared';

function formatDuration(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}:${sec.toString().padStart(2, '0')}`;
}

function formatCost(usd: number): string {
  if (usd < 0.01) return '<$0.01';
  return `$${usd.toFixed(2)}`;
}

export function CostIndicator({ cost }: { cost: CostUpdateMessage | null }) {
  if (!cost) return null;

  return (
    <div
      className="flex gap-2 items-center text-[0.7rem] text-[#777] cursor-default"
      title={`Voice: ${formatCost(cost.breakdown.voice)} | Vision: ${formatCost(cost.breakdown.vision)}`}
    >
      <span className="tabular-nums">{formatDuration(cost.sessionDurationMs)}</span>
      <span className="text-accent font-medium">{formatCost(cost.estimatedCostUsd)}</span>
    </div>
  );
}
