import { createServer } from 'net';

const PORT_MIN = 18000;
const PORT_MAX = 19000;

/**
 * Check if a TCP port is free by attempting to listen on it.
 */
function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => {
      srv.close(() => resolve(true));
    });
    srv.listen(port, '127.0.0.1');
  });
}

/**
 * Find a free port in the 18000-19000 range.
 * Starts at a random offset to avoid collisions between multiple installs.
 *
 * Note: This is a best-effort TOCTOU check — the port could be claimed between
 * this probe and core actually starting. Core's EADDRINUSE retry loop in
 * server.ts is the safety net for that race.
 */
export async function findFreePort(): Promise<number> {
  const start = PORT_MIN + Math.floor(Math.random() * (PORT_MAX - PORT_MIN));

  // Scan from random start to end of range
  for (let port = start; port < PORT_MAX; port++) {
    if (await isPortFree(port)) return port;
  }
  // Wrap around to beginning of range
  for (let port = PORT_MIN; port < start; port++) {
    if (await isPortFree(port)) return port;
  }
  throw new Error(`No free port found in range ${PORT_MIN}-${PORT_MAX}`);
}
