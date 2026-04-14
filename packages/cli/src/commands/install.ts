import * as p from '@clack/prompts';
import { copyFileSync, existsSync, mkdirSync, readdirSync } from 'fs';
import { join } from 'path';
import {
  ensureNeuraHome,
  loadConfig,
  saveConfig,
  getNeuraHome,
  generateAuthToken,
} from '../config.js';
import { getServiceManager } from '../service/manager.js';
import { getPlatformLabel } from '../service/detect.js';
import { checkHealth, waitForHealthy } from '../health.js';
import { hasCoreBinary, getBundledModelsDir } from '../download.js';
import { findFreePort } from '../port.js';
import {
  PROVIDER_PRESETS,
  buildRoutingFromFeatures,
  getVoiceOptions,
  type FeatureSelections,
  type VoiceMode,
  type VisionMode,
} from '../providers.js';
import { validateProviderKey } from '../validate-key.js';
import type { NeuraConfigFile } from '@neura/types';

// ─── Bundled Model Installer ───────────────────────────────────

function installBundledModels(neuraHome: string): string[] {
  const src = getBundledModelsDir();
  if (!existsSync(src)) return [];

  const dest = join(neuraHome, 'models');
  mkdirSync(dest, { recursive: true });

  const copied: string[] = [];
  try {
    for (const entry of readdirSync(src)) {
      if (!entry.endsWith('.onnx')) continue;
      const destPath = join(dest, entry);
      if (existsSync(destPath)) continue;
      copyFileSync(join(src, entry), destPath);
      copied.push(entry);
    }
  } catch {
    // Non-fatal — core warns if models are missing.
  }
  return copied;
}

// ─── Helpers ───────────────────────────────────────────────────

function cancelled(): never {
  p.outro('Setup cancelled.');
  process.exit(0);
}

/** Restore stdin raw mode on Windows after spinner stops (clack #408). */
function fixWindowsStdin(): void {
  if (process.platform === 'win32' && process.stdin.isTTY) {
    process.stdin.setRawMode(false);
  }
}

function describeExistingFeatures(config: NeuraConfigFile): string[] {
  const features: string[] = [];
  if (config.routing?.voice) {
    const mode = config.routing.voice.mode === 'realtime' ? 'realtime' : 'pipeline';
    features.push(`Voice (${mode})`);
  }
  if (config.routing?.vision) {
    features.push(`Vision (${config.routing.vision.mode})`);
  }
  if (config.routing?.text) {
    features.push(`Brain (${config.routing.text.provider})`);
  }
  if (config.routing?.embedding) {
    features.push(`Memory (${config.routing.embedding.provider})`);
  }
  if (config.routing?.worker) {
    features.push(`Agents (${config.routing.worker.provider})`);
  }
  return features;
}

// ─── Install Options ───────────────────────────────────────────

export interface InstallOptions {
  yes?: boolean;
}

// ─── Main Install Command ──────────────────────────────────────

export async function installCommand(opts: InstallOptions = {}): Promise<void> {
  const nonInteractive = !!opts.yes;
  const home = getNeuraHome();

  // ── Intro ────────────────────────────────────────────────────
  p.intro('Neura Setup');

  // Discover wake words
  ensureNeuraHome();
  const config = loadConfig();
  const seededModels = installBundledModels(home);

  const modelsDir = join(home, 'models');
  const infra = new Set(['melspectrogram', 'embedding_model']);
  let wakeWords: string[] = [];
  try {
    wakeWords = readdirSync(modelsDir)
      .filter((f) => f.endsWith('.onnx'))
      .map((f) => f.replace('.onnx', ''))
      .filter((name) => !infra.has(name));
  } catch {
    // models dir might not exist
  }

  const platformInfo = `Platform: ${getPlatformLabel()} · Home: ${home}`;
  const wakeInfo =
    wakeWords.length > 0
      ? `Wake words: ${wakeWords.join(', ')} (active: ${config.assistantName ?? 'jarvis'})`
      : '';
  const seedInfo =
    seededModels.length > 0 ? `Installed ${seededModels.length} wake-word model(s)` : '';

  p.log.info([platformInfo, wakeInfo, seedInfo].filter(Boolean).join('\n'));

  // ── Check if already running ─────────────────────────────────
  const existing = (config.port ?? 0) > 0 ? await checkHealth(config.port ?? 0) : null;
  if (existing) {
    p.log.success(`Core is already running on port ${existing.port}`);
    if (!nonInteractive) {
      const reinstall = await p.confirm({ message: 'Reinstall?', initialValue: false });
      if (p.isCancel(reinstall) || !reinstall) cancelled();
    }
  }

  // ── Non-interactive mode: skip wizard, go to service registration ──
  if (nonInteractive) {
    await registerServiceAndFinish(config);
    return;
  }

  // ── Existing config detection ────────────────────────────────
  const existingProviders = Object.keys(config.providers ?? {});
  let keepExisting = false;

  if (existingProviders.length > 0) {
    const features = describeExistingFeatures(config);
    if (features.length > 0) {
      p.log.info(`Existing features: ${features.join(', ')}`);
    }
    const keep = await p.confirm({
      message: "Re-use existing API keys? (you'll still pick features)",
      initialValue: true,
    });
    if (p.isCancel(keep)) cancelled();
    keepExisting = keep;
  }

  // ═══════════════════════════════════════════════════════════════
  // PHASE 1 — Feature Selection
  // ═══════════════════════════════════════════════════════════════

  p.log.step("Let's configure your features.");

  // ── Voice ────────────────────────────────────────────────────
  const voiceChoice = await p.select({
    message: 'Voice — How Neura speaks and listens',
    options: [
      {
        value: 'realtime',
        label: 'Realtime',
        hint: 'natural, low-latency conversation (xAI Grok)',
      },
      {
        value: 'pipeline',
        label: 'Pipeline',
        hint: 'mix-and-match speech providers (STT → LLM → TTS)',
      },
      { value: 'skip', label: 'Skip', hint: 'no voice, text-only mode' },
    ],
  });
  if (p.isCancel(voiceChoice)) cancelled();
  const voiceMode = voiceChoice as VoiceMode;

  let sttProvider: string | undefined;
  let ttsProvider: string | undefined;

  if (voiceMode === 'pipeline') {
    const stt = await p.select({
      message: 'Speech-to-Text provider',
      options: [{ value: 'deepgram', label: 'Deepgram', hint: 'recommended' }],
    });
    if (p.isCancel(stt)) cancelled();
    sttProvider = stt as string;

    const tts = await p.select({
      message: 'Text-to-Speech provider',
      options: [
        { value: 'elevenlabs', label: 'ElevenLabs', hint: 'recommended' },
        { value: 'openai', label: 'OpenAI' },
      ],
    });
    if (p.isCancel(tts)) cancelled();
    ttsProvider = tts as string;
  }

  // ── Vision ───────────────────────────────────────────────────
  const visionChoice = await p.select({
    message: 'Vision — How Neura sees your screen and camera',
    options: [
      {
        value: 'streaming',
        label: 'Streaming',
        hint: 'continuous awareness, ~0.5 FPS (Google Gemini)',
      },
      {
        value: 'snapshot',
        label: 'Snapshot',
        hint: 'on-demand "what am I looking at?" (OpenAI, Anthropic)',
      },
      { value: 'skip', label: 'Skip', hint: 'no visual awareness' },
    ],
  });
  if (p.isCancel(visionChoice)) cancelled();
  const visionMode = visionChoice as VisionMode;

  let snapshotProvider: string | undefined;
  if (visionMode === 'snapshot') {
    const snap = await p.select({
      message: 'Snapshot vision provider',
      options: [
        { value: 'openai', label: 'OpenAI', hint: 'GPT-4.1' },
        { value: 'anthropic', label: 'Anthropic', hint: 'Claude' },
      ],
    });
    if (p.isCancel(snap)) cancelled();
    snapshotProvider = snap as string;
  }

  // ── Brain (required) ─────────────────────────────────────────
  const brainChoice = await p.select({
    message: 'Brain — The core AI that powers thinking, tools, and conversation (required)',
    options: [
      { value: 'google', label: 'Google Gemini', hint: 'recommended' },
      { value: 'openai', label: 'OpenAI' },
      { value: 'anthropic', label: 'Anthropic (Claude)' },
      { value: 'xai', label: 'xAI (Grok)' },
      { value: 'openrouter', label: 'OpenRouter', hint: 'gateway to many models' },
      { value: 'vercel', label: 'Vercel AI Gateway', hint: 'multi-provider gateway' },
      { value: 'custom', label: 'Custom', hint: 'any OpenAI-compatible endpoint' },
    ],
  });
  if (p.isCancel(brainChoice)) cancelled();
  const brainProvider = brainChoice as string;

  let customProvider: { name: string; baseUrl: string; model: string } | undefined;
  if (brainProvider === 'custom') {
    const name = await p.text({
      message: 'Provider name (e.g. together, groq):',
      validate: (v) => (!v || v.length === 0 ? 'Required' : undefined),
    });
    if (p.isCancel(name)) cancelled();

    const baseUrl = await p.text({
      message: 'Base URL (e.g. https://api.together.xyz/v1):',
      validate: (v) => {
        if (!v || v.length === 0) return 'Required';
        if (!v.startsWith('http')) return 'Must start with http:// or https://';
        return undefined;
      },
    });
    if (p.isCancel(baseUrl)) cancelled();

    const model = await p.text({
      message: 'Default model (e.g. meta-llama/Llama-4-Scout-17B-16E):',
      validate: (v) => (!v || v.length === 0 ? 'Required' : undefined),
    });
    if (p.isCancel(model)) cancelled();

    customProvider = { name: name, baseUrl: baseUrl, model: model };
  }

  // ── Memory ───────────────────────────────────────────────────
  const memoryChoice = await p.select({
    message: 'Memory — Remember things across conversations',
    options: [
      {
        value: 'google',
        label: 'Google Gemini Embedding',
        hint: 'recommended, best recall quality',
      },
      { value: 'openai', label: 'OpenAI Embedding' },
      { value: 'vercel', label: 'Vercel AI Gateway Embedding' },
      { value: 'skip', label: 'Skip', hint: 'keyword search only, no semantic recall' },
    ],
  });
  if (p.isCancel(memoryChoice)) cancelled();
  const memoryProvider = memoryChoice as string;

  // ── Agents ───────────────────────────────────────────────────
  const wantAgents = await p.confirm({
    message: 'Agents — Delegate complex work to AI that operates independently and reports back',
    initialValue: true,
  });
  if (p.isCancel(wantAgents)) cancelled();

  let agentProvider = 'skip';
  if (wantAgents) {
    // Collect all text-capable providers the user has already selected
    const textProviders = new Set<string>();
    if (voiceMode === 'realtime') textProviders.add('xai');
    if (brainProvider !== 'custom') textProviders.add(brainProvider);
    if (customProvider) textProviders.add(customProvider.name);

    // If vision streaming selected, google is available too
    if (visionMode === 'streaming') textProviders.add('google');

    const providerOptions = [...textProviders]
      .filter(
        (id) => PROVIDER_PRESETS[id]?.capabilities.includes('worker') || id === customProvider?.name
      )
      .map((id) => ({
        value: id,
        label: PROVIDER_PRESETS[id]?.label ?? id,
      }));

    if (providerOptions.length > 1) {
      const agent = await p.select({
        message: 'Agent provider',
        options: providerOptions,
      });
      if (p.isCancel(agent)) cancelled();
      agentProvider = agent;
    } else if (providerOptions.length === 1) {
      agentProvider = providerOptions[0].value;
    } else {
      agentProvider =
        brainProvider === 'custom' && customProvider ? customProvider.name : brainProvider;
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // Build routing from feature selections
  // ═══════════════════════════════════════════════════════════════

  const selections: FeatureSelections = {
    voice: voiceMode,
    sttProvider,
    ttsProvider,
    vision: visionMode,
    snapshotProvider,
    brainProvider,
    memoryProvider,
    agentProvider,
    customProvider,
  };

  const result = buildRoutingFromFeatures(selections);

  // ═══════════════════════════════════════════════════════════════
  // PHASE 2 — API Key Collection
  // ═══════════════════════════════════════════════════════════════

  const keyLines: string[] = [];
  for (const [providerId, features] of result.requiredProviders) {
    const preset = PROVIDER_PRESETS[providerId];
    const label = preset?.label ?? providerId;
    const url = preset?.consoleUrl ?? '';
    keyLines.push(`${label}  →  ${features.join(', ')}${url ? `\n  ${url}` : ''}`);
  }

  p.note(keyLines.join('\n\n'), `You need ${result.requiredProviders.size} API key(s)`);

  // Collect keys
  const collectedKeys: Record<string, { apiKey: string; baseUrl?: string }> = {};

  // Carry over existing keys if keeping config
  if (keepExisting && config.providers) {
    for (const [id, creds] of Object.entries(config.providers)) {
      collectedKeys[id] = { ...creds };
    }
  }

  for (const [providerId] of result.requiredProviders) {
    const preset = PROVIDER_PRESETS[providerId];
    const label = preset?.label ?? providerId;
    const existingKey = collectedKeys[providerId]?.apiKey;

    // Custom provider — use the user-provided baseUrl
    const isCustom = !preset && providerId === customProvider?.name;
    const baseUrl = isCustom ? customProvider!.baseUrl : undefined;

    const hint = existingKey ? ' (press Enter to keep existing)' : '';
    const key = await p.password({
      message: `${label} API Key${hint}:`,
      mask: '*',
    });
    if (p.isCancel(key)) cancelled();

    let finalKey = key || existingKey || '';
    if (!finalKey) {
      p.log.warn(
        `No key provided for ${label} — features using this provider will be unavailable.`
      );
      continue;
    }

    // Validate
    const s = p.spinner();
    s.start(`Validating ${label} key...`);

    const vr = await validateProviderKey(providerId, finalKey, baseUrl);
    fixWindowsStdin();

    let validated = false;
    if (vr.valid) {
      s.stop(`${label}: Valid`);
      validated = true;
    } else {
      s.stop(`${label}: ${vr.error ?? 'Invalid key'}`);
      fixWindowsStdin();
      p.log.warn(`Validation failed: ${vr.error ?? 'Invalid key'}`);

      const retry = await p.confirm({
        message: `Try a different ${label} key?`,
        initialValue: true,
      });
      if (p.isCancel(retry)) cancelled();

      if (retry) {
        const retryKey = await p.password({
          message: `${label} API Key:`,
          mask: '*',
        });
        if (p.isCancel(retryKey)) cancelled();
        if (retryKey) {
          const vr2 = await validateProviderKey(providerId, retryKey, baseUrl);
          fixWindowsStdin();
          if (vr2.valid) {
            finalKey = retryKey;
            p.log.success(`${label}: Valid`);
            validated = true;
          } else {
            p.log.warn(`Retry failed: ${vr2.error ?? 'Invalid key'}`);
          }
        }
      }

      if (!validated) {
        const continueAnyway = await p.confirm({
          message: `Continue without a valid ${label} key?`,
          initialValue: false,
        });
        if (p.isCancel(continueAnyway)) cancelled();
        if (!continueAnyway) cancelled();
      }
    }

    if (validated) {
      collectedKeys[providerId] = { apiKey: finalKey, baseUrl };
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // PHASE 3 — Final Config
  // ═══════════════════════════════════════════════════════════════

  // Show configuration summary
  const summaryLines: string[] = [];
  const r = result.routing;

  if (r.voice) {
    if (r.voice.mode === 'realtime') {
      summaryLines.push(`✓ Voice:   Realtime (${r.voice.provider} / ${r.voice.model})`);
    } else {
      summaryLines.push(
        `✓ Voice:   Pipeline (STT: ${r.voice.stt.provider}, LLM: ${r.voice.llm.provider}, TTS: ${r.voice.tts.provider})`
      );
    }
  } else {
    summaryLines.push('✗ Voice:   Skipped');
  }

  if (r.vision) {
    summaryLines.push(
      `✓ Vision:  ${r.vision.mode === 'streaming' ? 'Streaming' : 'Snapshot'} (${r.vision.provider} / ${r.vision.model})`
    );
  } else {
    summaryLines.push('✗ Vision:  Skipped');
  }

  if (r.text) {
    summaryLines.push(`✓ Brain:   ${r.text.provider} / ${r.text.model}`);
  }

  if (r.embedding) {
    summaryLines.push(
      `✓ Memory:  ${r.embedding.provider} / ${r.embedding.model} (${r.embedding.dimensions}d)`
    );
  } else {
    summaryLines.push('✗ Memory:  Skipped');
  }

  if (r.worker) {
    summaryLines.push(`✓ Agents:  ${r.worker.provider} / ${r.worker.model}`);
  } else {
    summaryLines.push('✗ Agents:  Skipped');
  }

  if (result.warnings.length > 0) {
    summaryLines.push('');
    for (const w of result.warnings) {
      summaryLines.push(`⚠ ${w}`);
    }
  }

  p.note(summaryLines.join('\n'), 'Configuration Summary');

  // ── Port ─────────────────────────────────────────────────────
  let port: number;
  let portSource: string;
  if ((config.port ?? 0) > 0) {
    port = config.port!;
    portSource = 'configured';
  } else {
    port = await findFreePort();
    portSource = 'auto-assigned';
  }

  const customPort = await p.text({
    message: `Port: ${port} (${portSource})`,
    placeholder: 'press Enter to accept, or type a custom port',
    defaultValue: String(port),
    validate: (v) => {
      if (!v || v === '' || v === String(port)) return undefined;
      if (!/^\d+$/.test(v)) return 'Must be a number';
      const n = parseInt(v, 10);
      if (n < 1 || n > 65535) return 'Must be 1-65535';
      return undefined;
    },
  });
  if (p.isCancel(customPort)) cancelled();
  port = parseInt(customPort, 10);

  // ── Voice selection ──────────────────────────────────────────
  let voice: string | undefined;
  const voiceOpts = getVoiceOptions(selections);
  if (voiceOpts) {
    const voiceSelect = await p.select({
      message: 'Voice',
      options: voiceOpts.voices,
      initialValue: voiceOpts.defaultVoice,
    });
    if (p.isCancel(voiceSelect)) cancelled();
    voice = voiceSelect;
  }

  // ── Assemble and save config ─────────────────────────────────
  if (!config.authToken) {
    config.authToken = generateAuthToken();
  }

  // Merge collected keys into providers
  config.providers = { ...(keepExisting ? config.providers : {}), ...collectedKeys };

  // Set routing
  config.routing = result.routing;

  // Apply voice to the route
  if (voice && config.routing.voice) {
    if (config.routing.voice.mode === 'realtime') {
      config.routing.voice.voice = voice;
    } else {
      config.routing.voice.tts.voice = voice;
    }
  }

  config.port = port;
  saveConfig(config);

  p.log.info(`Config saved to ${home}/config.json`);

  // ── Service registration & health check ──────────────────────
  await registerServiceAndFinish(config);
}

// ─── Service Registration (shared by interactive and --yes) ────

async function registerServiceAndFinish(config: NeuraConfigFile): Promise<void> {
  // Sanity check — core is bundled inside this npm package
  if (!hasCoreBinary()) {
    p.log.error(
      'Core bundle not found inside this CLI install.\n' +
        'This indicates a broken installation. Fix with:\n' +
        '  npm install -g @mclean-capital/neura@latest'
    );
    return;
  }

  const s = p.spinner();
  s.start('Registering service...');

  let serviceRegistered = false;
  try {
    const svc = await getServiceManager();
    const wasInstalled = svc.isInstalled();

    if (wasInstalled && svc.isRunning()) {
      try {
        svc.stop();
      } catch {
        // Race condition: service may have stopped between check and stop
      }
    }
    await svc.install();
    s.stop(`Service ${wasInstalled ? 're-registered' : 'registered'} (${getPlatformLabel()})`);
    fixWindowsStdin();

    // Windows install mode info
    if (process.platform === 'win32') {
      const win = await import('../service/windows.js');
      const mode = win.getLastInstallMode();
      if (mode === 'startup-shim') {
        p.log.info(
          'Using Startup folder shim — Scheduled Task registration was not available.\n' +
            'Core will still run at each user login.'
        );
      } else if (mode === 'scheduled-task') {
        p.log.info('Registered in Task Scheduler under name "neura-core"');
      }
    }

    svc.start();
    serviceRegistered = true;
  } catch (err) {
    s.stop('Service registration skipped');
    fixWindowsStdin();
    p.log.warn(err instanceof Error ? err.message : String(err));
    p.log.info('Config was saved. Try again after resolving the issue.');
  }

  // Wait for health
  if (serviceRegistered) {
    const hs = p.spinner();
    hs.start('Waiting for core...');
    const health = await waitForHealthy(config.port ?? 0);
    if (health) {
      hs.stop(`Core healthy on port ${health.port}`);
      fixWindowsStdin();
    } else {
      hs.stop('Core did not respond within 15s');
      fixWindowsStdin();
      p.log.warn('Check logs: neura logs');
    }
  }

  // ── Done ─────────────────────────────────────────────────────
  if (serviceRegistered) {
    p.note(
      'Desktop:  Open the Neura desktop app\n' +
        'Web:      neura open\n' +
        'Status:   neura status\n' +
        'Logs:     neura logs',
      'Ready!'
    );
  } else {
    p.note(
      'neura start    Start the service\n' + 'neura status   Check service state',
      'Config saved. Service not yet running.'
    );
  }

  p.outro('Setup complete.');
}

// Exported for tests only.
export const __test__ = {
  installBundledModels,
};
