import Store from 'electron-store';
import { safeStorage } from 'electron';
import { randomBytes } from 'crypto';

interface StoredConfig {
  setupComplete: boolean;
  apiKeys: {
    xai: string;
    google: string;
  };
  voice: string;
  port: number;
  launchAtStartup: boolean;
  startMinimized: boolean;
  globalHotkey: string;
  authToken: string;
}

// Lazy-initialized — electron-store calls app.getPath('userData') which fails before app.ready
let _store: Store<StoredConfig> | null = null;
function store(): Store<StoredConfig> {
  if (!_store) {
    _store = new Store<StoredConfig>({
      defaults: {
        setupComplete: false,
        apiKeys: { xai: '', google: '' },
        voice: 'eve',
        port: 3002,
        launchAtStartup: false,
        startMinimized: false,
        globalHotkey: 'CommandOrControl+Shift+N',
        authToken: '',
      },
    });
  }
  return _store;
}

function encrypt(plaintext: string): string {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error(
      'OS keychain encryption is not available. Neura requires secure storage for API keys.'
    );
  }
  const buf = safeStorage.encryptString(plaintext);
  return buf.toString('base64');
}

function decrypt(encrypted: string): string {
  if (!encrypted) return encrypted;
  if (!safeStorage.isEncryptionAvailable()) return encrypted;
  try {
    const buf = Buffer.from(encrypted, 'base64');
    return safeStorage.decryptString(buf);
  } catch {
    // Decryption failed (keychain reset, machine migration, etc.)
    // Clear stored keys so the wizard re-prompts
    console.error('[store] decryption failed — clearing stored keys');
    store().set('apiKeys', { xai: '', google: '' });
    store().set('setupComplete', false);
    return '';
  }
}

export function getStore() {
  return {
    isSetupComplete: () => store().get('setupComplete'),
    setSetupComplete: (v: boolean) => store().set('setupComplete', v),

    getApiKeys: () => ({
      xaiApiKey: decrypt(store().get('apiKeys.xai')),
      googleApiKey: decrypt(store().get('apiKeys.google')),
    }),
    setApiKeys: (xai: string, google: string) => {
      store().set('apiKeys.xai', encrypt(xai));
      store().set('apiKeys.google', encrypt(google));
    },

    getVoice: () => store().get('voice'),
    setVoice: (v: string) => store().set('voice', v),
    getPort: () => store().get('port'),
    getHotkey: () => store().get('globalHotkey'),
    getLaunchAtStartup: () => store().get('launchAtStartup'),
    getStartMinimized: () => store().get('startMinimized'),

    /** Get or generate a persistent auth token for core ↔ client communication. */
    getAuthToken: (): string => {
      const stored = store().get('authToken');

      // Generate new token if none stored
      if (!stored) {
        const token = randomBytes(32).toString('hex');
        try {
          store().set('authToken', encrypt(token));
        } catch {
          // safeStorage unavailable — store plaintext as fallback
          store().set('authToken', token);
        }
        return token;
      }

      // Decrypt existing token
      const decrypted = decrypt(stored);
      if (decrypted) return decrypted;

      // Decrypt failed (keychain reset) — regenerate
      console.error('[store] auth token decryption failed — regenerating');
      store().set('authToken', '');
      const token = randomBytes(32).toString('hex');
      try {
        store().set('authToken', encrypt(token));
      } catch {
        store().set('authToken', token);
      }
      return token;
    },
  };
}
