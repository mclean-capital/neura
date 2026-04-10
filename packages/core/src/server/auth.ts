import { timingSafeEqual } from 'crypto';

/**
 * Timing-safe token comparison.
 * Burns the same CPU time regardless of whether lengths match
 * to prevent length-leaking via timing side-channels.
 */
export function verifyToken(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) {
    // Compare expected against itself to burn equal CPU time
    timingSafeEqual(b, b);
    return false;
  }
  return timingSafeEqual(a, b);
}
