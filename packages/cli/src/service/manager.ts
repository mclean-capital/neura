import { detectPlatform, type Platform } from './detect.js';

export interface ServiceManager {
  isInstalled(): boolean;
  isRunning(): boolean;
  install(): void | Promise<void>;
  uninstall(): void | Promise<void>;
  start(): void;
  stop(): void;
  restart(): void;
  getLogPath(): string;
}

/**
 * Returns the platform-specific service manager.
 * Dynamically imports to avoid loading Windows-specific code on macOS, etc.
 */
export async function getServiceManager(): Promise<ServiceManager> {
  const platform = detectPlatform();

  const loaders: Record<Platform, () => Promise<{ default: ServiceManager }>> = {
    windows: () => import('./windows.js'),
    macos: () => import('./macos.js'),
    linux: () => import('./linux.js'),
  };

  const mod = await loaders[platform]();
  return mod.default;
}
