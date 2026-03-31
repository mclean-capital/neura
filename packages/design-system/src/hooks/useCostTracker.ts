import { useCallback, useState } from 'react';
import type { CostUpdateMessage } from '@neura/types';

export function useCostTracker() {
  const [cost, setCost] = useState<CostUpdateMessage | null>(null);

  const handleCostUpdate = useCallback((msg: CostUpdateMessage) => {
    setCost(msg);
  }, []);

  return { cost, handleCostUpdate };
}
