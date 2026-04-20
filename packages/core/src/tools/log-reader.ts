/**
 * Log reader for the orchestrator's `read_log` tool.
 *
 * Two log sources the orchestrator cares about:
 *
 *   1. `<neuraHome>/logs/core.log` — the core process's pino stream
 *      (all namespaces: voice, tool, pi-runtime, agent-worker, etc.).
 *      Authoritative for platform-level events: auth errors, dispatch
 *      failures, crash detection.
 *
 *   2. `<neuraHome>/agent/sessions/<sessionId>.jsonl` — pi's per-session
 *      transcript (one file per dispatched worker). Authoritative for
 *      "what did this worker actually do": every assistant turn, tool
 *      call, tool result, error.
 *
 * Safety (see prompt-injection threat model): the reader accepts a
 * path but resolves + normalizes it and rejects anything outside the
 * allow-list of log roots. A model tricked into asking for
 * `~/.ssh/id_rsa` or `~/.neura/config.json` gets an error back —
 * the tool has no capability to read files outside its two roots.
 *
 * I/O is bounded: we read at most `tailBytes` bytes from the end of
 * the file via `fs.openSync` + `fs.readSync`. We never pull a multi-GB
 * file into memory to slice it.
 *
 * Format: each line is parsed as JSON first; non-JSON lines fall
 * through to an opaque-text entry so pino-pretty output (dev mode)
 * and pi session entries with different shapes both work.
 */

import { closeSync, existsSync, openSync, readSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, resolve, sep } from 'node:path';

/** Max bytes of log tail we'll read in a single call. */
const DEFAULT_TAIL_BYTES = 256 * 1024;

/** Hard upper bound; callers that ask for more are capped here. */
const MAX_TAIL_BYTES = 1 * 1024 * 1024;

/** Max entries returned in a single call. */
const MAX_RETURN_ENTRIES = 100;

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

const LEVEL_NUM: Record<LogLevel, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
};

/**
 * A log entry in the shape we return to the voice-facing tool.
 * `kind: 'json'` entries came from a parseable JSONL line; `'text'`
 * entries are opaque lines (pino-pretty output, unparseable records).
 *
 * IDs have been redacted — UUIDs are stripped from `content` and any
 * `fields` map before the entry leaves the reader, so the voice model
 * can't vocalize them. Callers that need the raw data should use the
 * store queries directly, not this tool.
 */
export interface LogEntry {
  /** ISO timestamp when available (pino `time`, pi `timestamp`, parsed prefix). */
  time?: string;
  /** Pino-style level if the source provided one, else undefined. */
  level?: LogLevel;
  /** Source namespace if present (e.g. pino `ns`, pi `entryType`). */
  ns?: string;
  /** Primary message text. */
  msg: string;
  /** Original record kind — JSON if we could parse, text otherwise. */
  kind: 'json' | 'text';
  /** Other scalar fields after redaction. */
  fields?: Record<string, string | number | boolean>;
}

/**
 * Symbolic source handles the orchestrator can pass instead of a raw
 * path. `core` → the platform log. `session` requires `sessionFile`
 * (relative path like `agent/sessions/<id>.jsonl`) that the caller
 * looked up via `get_task`.
 */
export type LogSource = { kind: 'core' } | { kind: 'session'; sessionFile: string };

export interface ReadLogOptions {
  /** Absolute path of the neura home directory (log root base). */
  neuraHome: string;
  /** Choose source by handle OR by explicit relative path (mutually exclusive). */
  source?: LogSource;
  /** Relative path under `neuraHome`. Rejected if it escapes allow-listed roots. */
  path?: string;
  /** Filter to entries mentioning this workerId (string match in JSON fields or text). */
  workerId?: string;
  /** Filter to entries mentioning this taskId. */
  taskId?: string;
  /** Minimum level for JSON entries (ignored for text entries, which always pass). Default `warn`. */
  minLevel?: LogLevel;
  /** Max entries to return (1-100, default 30). */
  limit?: number;
  /** Bytes of file tail to scan (default 256 KB, max 1 MB). */
  tailBytes?: number;
}

export interface ReadLogResult {
  /** `false` when the file doesn't exist (first-run, wrong session id, etc.). */
  available: boolean;
  /** Resolved absolute path the reader consulted (present even when not available, for the caller to debug). */
  logPath?: string;
  /** Oldest-to-newest entries within the scanned window, after filtering. */
  entries: LogEntry[];
  /**
   * True when the tail window was hit — older entries exist but are
   * outside the scan range. Orchestrator can surface this so the user
   * knows to widen or ask an operator to inspect directly.
   */
  truncated: boolean;
  /** Present when the request was rejected for safety (path outside allow-list). */
  error?: string;
}

export function readLog(opts: ReadLogOptions): ReadLogResult {
  const resolved = resolveLogPath(opts);
  if ('error' in resolved) {
    return { available: false, entries: [], truncated: false, error: resolved.error };
  }
  const logPath = resolved.logPath;

  if (!existsSync(logPath)) {
    return { available: false, logPath, entries: [], truncated: false };
  }

  const tailBytes = Math.min(opts.tailBytes ?? DEFAULT_TAIL_BYTES, MAX_TAIL_BYTES);
  const minLevelNum = LEVEL_NUM[opts.minLevel ?? 'warn'];
  const limit = clamp(opts.limit ?? 30, 1, MAX_RETURN_ENTRIES);

  const { text, truncated, startsOnBoundary } = readTailBytes(logPath, tailBytes);

  // If the window starts mid-line, the first line is a fragment and
  // must be dropped. If it started exactly on a newline boundary (or
  // we're at the head of the file), every line is complete.
  // Also handle CRLF: split on either LF or CRLF so Windows-written
  // session files and legacy logs parse cleanly.
  const rawLines = text.split(/\r?\n/);
  const lines = truncated && !startsOnBoundary ? rawLines.slice(1) : rawLines;

  const matched: LogEntry[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    const entry = parseLine(line);
    if (!entry) continue;
    if (entry.kind === 'json' && entry.level && LEVEL_NUM[entry.level] < minLevelNum) continue;
    if (!matchesFilter(line, entry, opts)) continue;
    matched.push(redactEntry(entry));
  }

  const trimmed = matched.slice(-limit);
  return {
    available: true,
    logPath,
    entries: trimmed,
    truncated: truncated || matched.length > trimmed.length,
  };
}

// ────────────────────────────────────────────────────────────────────
// Path resolution + sandboxing
// ────────────────────────────────────────────────────────────────────

/**
 * Normalize the requested source/path into an absolute logPath that
 * lives under an allow-listed root. Anything else → error string.
 */
function resolveLogPath(opts: ReadLogOptions): { logPath: string } | { error: string } {
  const logsRoot = resolveAllowedRoot(opts.neuraHome, 'logs');
  const sessionsRoot = resolveAllowedRoot(opts.neuraHome, 'agent', 'sessions');
  const allowed = [logsRoot, sessionsRoot];

  let candidate: string;
  if (opts.source) {
    candidate =
      opts.source.kind === 'core'
        ? resolve(logsRoot, 'core.log')
        : resolve(sessionsRoot, stripSessionsPrefix(opts.source.sessionFile));
  } else if (opts.path) {
    const requested = opts.path;
    // Absolute paths are allowed but must still fall inside a root.
    candidate = isAbsolute(requested) ? resolve(requested) : resolve(opts.neuraHome, requested);
  } else {
    return { error: 'read_log requires source or path' };
  }

  if (!isUnderAllowedRoot(candidate, allowed)) {
    return {
      error: `path ${candidate} is outside allowed log roots (logs/ and agent/sessions/ under neuraHome)`,
    };
  }

  return { logPath: candidate };
}

function resolveAllowedRoot(neuraHome: string, ...parts: string[]): string {
  return resolve(neuraHome, ...parts);
}

/**
 * Accept a session path that may be relative to neuraHome
 * (`agent/sessions/abc.jsonl`) or relative to the sessions dir
 * (`abc.jsonl`) or already absolute. Normalize to the basename under
 * the sessions root.
 */
function stripSessionsPrefix(input: string): string {
  const prefix = `agent${sep}sessions${sep}`;
  const altPrefix = 'agent/sessions/';
  if (input.startsWith(prefix)) return input.slice(prefix.length);
  if (input.startsWith(altPrefix)) return input.slice(altPrefix.length);
  return input;
}

function isUnderAllowedRoot(path: string, roots: string[]): boolean {
  // Resolve symlinks when possible so an attacker can't escape via
  // a symlinked file in the allow-list. If the file doesn't exist
  // yet, fall back to the string prefix check — the file will be
  // opened later and statSync will fail cleanly if it's unreadable.
  let normalized = path;
  try {
    normalized = realpathSync(path);
  } catch {
    // Not yet existing — use the provided path. The existsSync gate
    // below handles the "not there" case.
  }
  for (const root of roots) {
    let normalizedRoot: string;
    try {
      normalizedRoot = realpathSync(root);
    } catch {
      normalizedRoot = root;
    }
    if (isPathInside(normalized, normalizedRoot)) return true;
  }
  return false;
}

function isPathInside(child: string, parent: string): boolean {
  const parentWithSep = parent.endsWith(sep) ? parent : parent + sep;
  return child === parent || child.startsWith(parentWithSep);
}

// ────────────────────────────────────────────────────────────────────
// Bounded tail read
// ────────────────────────────────────────────────────────────────────

function readTailBytes(
  path: string,
  tailBytes: number
): {
  text: string;
  truncated: boolean;
  /**
   * True when the byte immediately before our window is a newline
   * (or we're at the very start of the file). Lets the caller know
   * the first line is a full record, not a fragment — so we don't
   * drop a valid entry when the tail happens to land on a boundary.
   */
  startsOnBoundary: boolean;
} {
  const stat = statSync(path);
  const size = stat.size;
  const toRead = Math.min(tailBytes, size);
  const start = size - toRead;
  const buf = Buffer.alloc(toRead);
  const fd = openSync(path, 'r');
  try {
    let off = 0;
    let pos = start;
    while (off < toRead) {
      const n = readSync(fd, buf, off, toRead - off, pos);
      if (n === 0) break;
      off += n;
      pos += n;
    }
    let startsOnBoundary = start === 0;
    if (!startsOnBoundary && start > 0) {
      // Peek one byte before the window to see if we're mid-line
      // or aligned with a line break.
      const peek = Buffer.alloc(1);
      const n = readSync(fd, peek, 0, 1, start - 1);
      if (n === 1 && (peek[0] === 0x0a || peek[0] === 0x0d)) {
        startsOnBoundary = true;
      }
    }
    const text = buf.subarray(0, off).toString('utf8');
    return { text, truncated: start > 0, startsOnBoundary };
  } finally {
    closeSync(fd);
  }
}

// ────────────────────────────────────────────────────────────────────
// Line parsing (JSON with text fallback)
// ────────────────────────────────────────────────────────────────────

/**
 * Desktop (Electron) launcher writes core logs with a per-line
 * `[stdout] ` / `[stderr] ` prefix before piping to disk. Strip that
 * prefix so the JSON detector downstream sees the raw pino line.
 */
const DESKTOP_PREFIX = /^\s*\[(stdout|stderr)\]\s*/;

function parseLine(line: string): LogEntry | null {
  let trimmed = line.trim();
  if (!trimmed) return null;

  const m = DESKTOP_PREFIX.exec(trimmed);
  if (m) trimmed = trimmed.slice(m[0].length);

  if (trimmed.startsWith('{')) {
    try {
      const obj = JSON.parse(trimmed) as Record<string, unknown>;
      return parseJsonEntry(obj) ?? asText(trimmed);
    } catch {
      return asText(trimmed);
    }
  }
  return asText(trimmed);
}

function parseJsonEntry(obj: Record<string, unknown>): LogEntry | null {
  if (typeof obj !== 'object' || obj === null) return null;

  // Pino-shaped record (level, time, msg, ns, ...).
  const level = coerceLevel(obj.level);
  const timeMs = typeof obj.time === 'number' ? obj.time : undefined;
  const time =
    timeMs !== undefined
      ? new Date(timeMs).toISOString()
      : typeof obj.timestamp === 'string'
        ? obj.timestamp
        : undefined;

  // Pi session entries tend to carry `type` (entry type) and either
  // `content` or nested message shapes. Normalize both into a single
  // readable `msg` so the orchestrator doesn't need to know which
  // source emitted the record.
  const ns =
    typeof obj.ns === 'string'
      ? obj.ns
      : typeof obj.type === 'string'
        ? `session:${obj.type}`
        : undefined;
  const msg =
    typeof obj.msg === 'string'
      ? obj.msg
      : typeof obj.message === 'string'
        ? obj.message
        : typeof obj.content === 'string'
          ? obj.content
          : JSON.stringify(shallowSummary(obj));

  const structural = new Set([
    'level',
    'time',
    'pid',
    'hostname',
    'ns',
    'msg',
    'v',
    'type',
    'content',
    'message',
    'timestamp',
  ]);
  const fields: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (structural.has(key)) continue;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      fields[key] = value;
    }
  }

  return {
    kind: 'json',
    msg,
    ...(time ? { time } : {}),
    ...(level ? { level } : {}),
    ...(ns ? { ns } : {}),
    ...(Object.keys(fields).length > 0 ? { fields } : {}),
  };
}

function asText(line: string): LogEntry {
  // Try to pull an ISO timestamp off the front (pino-pretty prefixes
  // with `[HH:MM:SS.sss]` by default; bare pino-pretty stdio is
  // colorful text). Best-effort only.
  const m = /^\[(\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?)\]/.exec(line);
  const time = m?.[1];
  return {
    kind: 'text',
    msg: line,
    ...(time ? { time } : {}),
  };
}

function shallowSummary(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      out[key] = value;
    }
  }
  return out;
}

function coerceLevel(raw: unknown): LogLevel | undefined {
  if (typeof raw === 'number') {
    if (raw < LEVEL_NUM.trace) return undefined;
    let match: LogLevel = 'trace';
    for (const [name, num] of Object.entries(LEVEL_NUM) as [LogLevel, number][]) {
      if (raw >= num) match = name;
    }
    return match;
  }
  if (typeof raw === 'string' && raw in LEVEL_NUM) return raw as LogLevel;
  return undefined;
}

// ────────────────────────────────────────────────────────────────────
// Filtering + UUID redaction
// ────────────────────────────────────────────────────────────────────

function matchesFilter(rawLine: string, entry: LogEntry, opts: ReadLogOptions): boolean {
  if (opts.workerId) {
    if (!lineMentions(rawLine, entry, opts.workerId)) return false;
  }
  if (opts.taskId) {
    if (!lineMentions(rawLine, entry, opts.taskId)) return false;
  }
  return true;
}

function lineMentions(rawLine: string, entry: LogEntry, needle: string): boolean {
  // Cheap contains check on the raw line catches JSON records,
  // pino-pretty text, and pi session lines equally.
  if (rawLine.includes(needle)) return true;
  if (entry.msg.includes(needle)) return true;
  if (entry.fields) {
    for (const v of Object.values(entry.fields)) {
      if (typeof v === 'string' && v.includes(needle)) return true;
    }
  }
  return false;
}

// UUID v4-ish pattern. Used to scrub IDs out of strings before the
// entry reaches the voice model, which would otherwise narrate them
// letter-by-letter.
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

function redactEntry(entry: LogEntry): LogEntry {
  return {
    ...entry,
    msg: entry.msg.replace(UUID_RE, '<id>'),
    ...(entry.fields ? { fields: redactFields(entry.fields) } : {}),
  };
}

function redactFields(
  fields: Record<string, string | number | boolean>
): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(fields)) {
    // Known ID keys: drop entirely. Keeps field maps compact and
    // removes the temptation for the model to read them aloud.
    if (key === 'workerId' || key === 'taskId' || key === 'sessionId' || key === 'toolCallId') {
      continue;
    }
    if (typeof value === 'string') {
      out[key] = value.replace(UUID_RE, '<id>');
    } else {
      out[key] = value;
    }
  }
  return out;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}
