import { useState } from 'react';

interface SetupWizardProps {
  onComplete: () => void;
}

export function SetupWizard({ onComplete }: SetupWizardProps) {
  const [xaiKey, setXaiKey] = useState('');
  const [googleKey, setGoogleKey] = useState('');
  const [xaiStatus, setXaiStatus] = useState<{ text: string; ok?: boolean } | null>(null);
  const [googleStatus, setGoogleStatus] = useState<{ text: string; ok?: boolean } | null>(null);
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);

  const handleValidate = async () => {
    if (!xaiKey.trim() || !googleKey.trim()) {
      if (!xaiKey.trim()) setXaiStatus({ text: 'Required', ok: false });
      if (!googleKey.trim()) setGoogleStatus({ text: 'Required', ok: false });
      return;
    }

    setLoading(true);
    setXaiStatus({ text: 'Checking...' });
    setGoogleStatus({ text: 'Checking...' });

    try {
      const [xaiResult, googleResult] = await Promise.all([
        window.neuraDesktop.validateKey('xai', xaiKey.trim()),
        window.neuraDesktop.validateKey('google', googleKey.trim()),
      ]);

      setXaiStatus({ text: xaiResult.valid ? 'Valid' : 'Invalid key', ok: xaiResult.valid });
      setGoogleStatus({
        text: googleResult.valid ? 'Valid' : 'Invalid key',
        ok: googleResult.valid,
      });

      if (xaiResult.valid && googleResult.valid) {
        await window.neuraDesktop.saveConfig({
          providers: {
            xai: { apiKey: xaiKey.trim() },
            google: { apiKey: googleKey.trim() },
          },
          routing: {
            voice: { mode: 'realtime', provider: 'xai', model: 'grok-realtime', voice: 'eve' },
            vision: { mode: 'streaming', provider: 'google', model: 'gemini-2.5-flash' },
            text: { provider: 'google', model: 'gemini-2.5-flash' },
            embedding: {
              provider: 'google',
              model: 'gemini-embedding-2-preview',
              dimensions: 3072,
            },
            worker: { provider: 'xai', model: 'grok-4-fast' },
          },
        });
        setDone(true);
      }
    } catch (err) {
      setXaiStatus({
        text: `Error: ${err instanceof Error ? err.message : 'Unknown'}`,
        ok: false,
      });
    }

    setLoading(false);
  };

  const handleLaunch = async () => {
    setLoading(true);
    if (window.neuraDesktop.startCore) {
      await window.neuraDesktop.startCore();
    }
    onComplete();
  };

  if (done) {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-4">
        <span className="text-5xl">&#10003;</span>
        <p className="text-dark-muted-light">You're all set!</p>
        <button
          className="px-8 py-3 rounded-full border-2 border-session-green bg-session-green-bg text-session-green cursor-pointer text-base font-medium transition-all duration-200 hover:bg-session-green-hover disabled:opacity-40 disabled:cursor-default"
          onClick={() => void handleLaunch()}
          disabled={loading}
        >
          {loading ? 'Starting...' : 'Launch Neura'}
        </button>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col items-center justify-center gap-6 px-8">
      <svg width="48" height="48" viewBox="0 0 72 72" fill="none">
        <path
          d="M18 56V16L54 56V16"
          stroke="#D4940A"
          strokeWidth="4"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      <span className="text-3xl font-medium tracking-[0.15em] text-dark-text font-display">
        NEURA
      </span>
      <p className="text-dark-muted-light text-sm">Let's get you set up</p>

      <div className="flex flex-col gap-4 w-full max-w-sm">
        <div className="flex flex-col gap-1">
          <label className="text-[0.8rem] text-dark-muted-light">xAI API Key (for voice)</label>
          <input
            type="password"
            className="w-full px-4 py-2.5 rounded-lg border border-dark-border bg-dark-elevated text-dark-text text-sm outline-nonefocus:border-accent"
            placeholder="xai-..."
            value={xaiKey}
            onChange={(e) => setXaiKey(e.target.value)}
          />
          <span className="text-[0.7rem] text-dark-muted">
            Get yours at{' '}
            <a
              href="#"
              className="text-accent"
              onClick={(e) => {
                e.preventDefault();
                void window.neuraDesktop.openExternal('https://console.x.ai');
              }}
            >
              console.x.ai
            </a>
          </span>
          {xaiStatus && (
            <span
              className={`text-xs ${xaiStatus.ok === true ? 'text-session-green' : xaiStatus.ok === false ? 'text-signal-danger' : 'text-dark-muted'}`}
            >
              {xaiStatus.text}
            </span>
          )}
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-[0.8rem] text-dark-muted-light">Google API Key (for vision)</label>
          <input
            type="password"
            className="w-full px-4 py-2.5 rounded-lg border border-dark-border bg-dark-elevated text-dark-text text-sm outline-nonefocus:border-accent"
            placeholder="AIza..."
            value={googleKey}
            onChange={(e) => setGoogleKey(e.target.value)}
          />
          <span className="text-[0.7rem] text-dark-muted">
            Get yours at{' '}
            <a
              href="#"
              className="text-accent"
              onClick={(e) => {
                e.preventDefault();
                void window.neuraDesktop.openExternal('https://aistudio.google.com/apikey');
              }}
            >
              aistudio.google.com
            </a>
          </span>
          {googleStatus && (
            <span
              className={`text-xs ${googleStatus.ok === true ? 'text-session-green' : googleStatus.ok === false ? 'text-signal-danger' : 'text-dark-muted'}`}
            >
              {googleStatus.text}
            </span>
          )}
        </div>

        <button
          className="mt-2 px-8 py-3 rounded-full border-2 border-session-green bg-session-green-bg text-session-green cursor-pointer text-base font-medium transition-all duration-200 hover:bg-session-green-hover disabled:opacity-40 disabled:cursor-default self-center"
          onClick={() => void handleValidate()}
          disabled={loading}
        >
          {loading ? 'Validating...' : 'Continue'}
        </button>
      </div>
    </div>
  );
}
