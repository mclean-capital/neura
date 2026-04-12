# Cost Tracker: Dynamic Pricing TODO

The `CostTracker` constructor accepts `Partial<ProviderPricing>` but the call site
in `websocket.ts` always uses `new CostTracker()` with defaults (Grok voice + Gemini
vision rates).

## What's needed

Wire per-provider pricing from the routing config into the CostTracker:

1. Build a pricing lookup table mapping provider IDs to rates
2. Pass the resolved voice + vision rates to `new CostTracker({ voiceRatePerMs, visionRatePerMs })`
3. For pipeline mode, pricing is more complex: STT (per-minute) + LLM (per-token) + TTS (per-character)
   — the current `ProviderPricing` interface only supports per-ms rates, so it needs extending
4. The `AdapterPricing` type in `@neura/types/adapters.ts` already has the right shape
   (`inputPer1kTokens`, `perMinuteAudio`, `per1kCharacters`) — bridge it into CostTracker

## Current impact

Sessions using non-default providers get Grok/Gemini pricing applied — costs are inaccurate
but not functionally broken. The session recording labels (provider/model) are correct,
so cost can be recalculated from session history if needed.
