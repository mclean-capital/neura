import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readLog, type LogEntry } from './log-reader.js';

let neuraHome: string;

beforeEach(() => {
  neuraHome = mkdtempSync(join(tmpdir(), 'neura-log-reader-'));
  mkdirSync(join(neuraHome, 'logs'), { recursive: true });
  mkdirSync(join(neuraHome, 'agent', 'sessions'), { recursive: true });
});

afterEach(() => {
  rmSync(neuraHome, { recursive: true, force: true });
});

function pino(entry: Record<string, unknown>): string {
  return JSON.stringify({ time: Date.now(), ...entry });
}

function writeCore(lines: string[]): string {
  const path = join(neuraHome, 'logs', 'core.log');
  writeFileSync(path, lines.join('\n') + '\n');
  return path;
}

function writeSession(id: string, lines: string[]): string {
  const path = join(neuraHome, 'agent', 'sessions', `${id}.jsonl`);
  writeFileSync(path, lines.join('\n') + '\n');
  return path;
}

describe('readLog — source resolution', () => {
  it('reads core.log via source=core', () => {
    writeCore([pino({ level: 50, ns: 'pi-runtime', workerId: 'w-1', msg: 'oops' })]);
    const result = readLog({ neuraHome, source: { kind: 'core' } });
    expect(result.available).toBe(true);
    expect(result.entries[0].msg).toBe('oops');
  });

  it('reads a session JSONL via source=session', () => {
    writeSession('abc123', [
      JSON.stringify({
        timestamp: '2026-04-20T10:00:00Z',
        type: 'message',
        content: 'hello from the worker',
      }),
    ]);
    const result = readLog({
      neuraHome,
      source: { kind: 'session', sessionFile: 'agent/sessions/abc123.jsonl' },
      minLevel: 'trace',
    });
    expect(result.available).toBe(true);
    expect(result.entries[0].msg).toBe('hello from the worker');
    expect(result.entries[0].ns).toBe('session:message');
  });

  it('accepts a bare filename for session_file', () => {
    writeSession('xyz', [JSON.stringify({ type: 'message', content: 'hi' })]);
    const result = readLog({
      neuraHome,
      source: { kind: 'session', sessionFile: 'xyz.jsonl' },
      minLevel: 'trace',
    });
    expect(result.available).toBe(true);
    expect(result.entries[0].msg).toBe('hi');
  });

  it('returns available:false when the file does not exist', () => {
    const result = readLog({
      neuraHome,
      source: { kind: 'session', sessionFile: 'agent/sessions/never-existed.jsonl' },
    });
    expect(result.available).toBe(false);
    expect(result.entries).toEqual([]);
  });

  it('errors when neither source nor path is given', () => {
    const result = readLog({ neuraHome });
    expect(result.available).toBe(false);
    expect(result.error).toMatch(/requires source or path/);
  });
});

describe('readLog — path sandboxing', () => {
  it('rejects absolute paths outside neuraHome', () => {
    const result = readLog({ neuraHome, path: '/etc/passwd' });
    expect(result.available).toBe(false);
    expect(result.error).toMatch(/outside allowed log roots/);
  });

  it('rejects relative paths that escape via ..', () => {
    const result = readLog({ neuraHome, path: '../../.ssh/id_rsa' });
    expect(result.available).toBe(false);
    expect(result.error).toMatch(/outside allowed log roots/);
  });

  it('rejects paths inside neuraHome but outside the two allow-listed roots', () => {
    writeFileSync(join(neuraHome, 'config.json'), '{"apiKey":"secret"}');
    const result = readLog({ neuraHome, path: 'config.json' });
    expect(result.available).toBe(false);
    expect(result.error).toMatch(/outside allowed log roots/);
  });

  it('accepts relative paths under logs/', () => {
    writeCore([pino({ level: 50, ns: 'x', msg: 'ok' })]);
    const result = readLog({ neuraHome, path: 'logs/core.log' });
    expect(result.available).toBe(true);
  });

  it('accepts relative paths under agent/sessions/', () => {
    writeSession('s1', [JSON.stringify({ type: 'message', content: 'ok' })]);
    const result = readLog({
      neuraHome,
      path: 'agent/sessions/s1.jsonl',
      minLevel: 'trace',
    });
    expect(result.available).toBe(true);
  });
});

describe('readLog — filtering', () => {
  it('filters JSON entries by workerId', () => {
    writeCore([
      pino({ level: 50, ns: 'pi-runtime', workerId: 'w-1', msg: 'mine' }),
      pino({ level: 50, ns: 'pi-runtime', workerId: 'w-2', msg: 'not mine' }),
    ]);
    const result = readLog({ neuraHome, source: { kind: 'core' }, workerId: 'w-1' });
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].msg).toBe('mine');
  });

  it('filters text entries by substring match on the raw line', () => {
    writeCore([
      '[10:00:00.123] ERROR (pi-runtime): something about w-1 went wrong',
      '[10:00:01.456] ERROR (pi-runtime): something about w-2 went wrong',
    ]);
    const result = readLog({
      neuraHome,
      source: { kind: 'core' },
      workerId: 'w-1',
      minLevel: 'trace',
    });
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].msg).toContain('w-1');
  });

  it('level-gates JSON entries (default warn+ skips info)', () => {
    writeCore([
      pino({ level: 30, ns: 'pi-runtime', workerId: 'w-1', msg: 'starting up' }),
      pino({ level: 50, ns: 'pi-runtime', workerId: 'w-1', msg: 'errored' }),
    ]);
    const result = readLog({ neuraHome, source: { kind: 'core' }, workerId: 'w-1' });
    expect(result.entries.map((e) => e.msg)).toEqual(['errored']);
  });

  it('includeInfo=true (minLevel=info) returns info+ entries', () => {
    writeCore([
      pino({ level: 30, ns: 'pi-runtime', workerId: 'w-1', msg: 'starting up' }),
      pino({ level: 50, ns: 'pi-runtime', workerId: 'w-1', msg: 'errored' }),
    ]);
    const result = readLog({
      neuraHome,
      source: { kind: 'core' },
      workerId: 'w-1',
      minLevel: 'info',
    });
    expect(result.entries.map((e) => e.msg)).toEqual(['starting up', 'errored']);
  });
});

describe('readLog — parsing', () => {
  it('falls back to text entry for non-JSON lines (pino-pretty)', () => {
    writeCore([
      '[10:00:00.123] ERROR (pi-runtime): readable text line',
      pino({ level: 50, ns: 'pi-runtime', msg: 'json line' }),
    ]);
    const result = readLog({ neuraHome, source: { kind: 'core' }, minLevel: 'trace' });
    const kinds = result.entries.map((e: LogEntry) => e.kind);
    expect(kinds).toContain('text');
    expect(kinds).toContain('json');
  });

  it('maps pino numeric time to ISO', () => {
    const ts = Date.parse('2026-04-20T10:00:00Z');
    writeCore([
      JSON.stringify({ time: ts, level: 50, ns: 'pi-runtime', workerId: 'w-1', msg: 'boom' }),
    ]);
    const result = readLog({ neuraHome, source: { kind: 'core' }, workerId: 'w-1' });
    expect(result.entries[0].time).toBe('2026-04-20T10:00:00.000Z');
  });

  it('tolerates malformed JSON without throwing', () => {
    writeCore(['{broken: "json"', pino({ level: 50, ns: 'pi-runtime', msg: 'good entry' })]);
    const result = readLog({ neuraHome, source: { kind: 'core' }, minLevel: 'trace' });
    expect(result.entries.map((e) => e.msg)).toContain('good entry');
  });
});

describe('readLog — UUID redaction', () => {
  it('scrubs UUIDs from msg', () => {
    const uuid = 'a47274d8-0a72-4659-be43-9b680303bf88';
    writeCore([
      pino({
        level: 50,
        ns: 'pi-runtime',
        workerId: uuid,
        msg: `boom on worker ${uuid}`,
      }),
    ]);
    const result = readLog({ neuraHome, source: { kind: 'core' }, workerId: uuid });
    expect(result.entries[0].msg).not.toContain(uuid);
    expect(result.entries[0].msg).toContain('<id>');
  });

  it('drops known ID fields from the fields map', () => {
    writeCore([
      JSON.stringify({
        time: Date.now(),
        level: 50,
        ns: 'agent-worker',
        workerId: 'w-1',
        taskId: 't-1',
        sessionId: 's-1',
        msg: 'failed',
        attempt: 3,
      }),
    ]);
    const result = readLog({ neuraHome, source: { kind: 'core' }, workerId: 'w-1' });
    expect(result.entries[0].fields).toEqual({ attempt: 3 });
  });
});

describe('readLog — bounded I/O', () => {
  it('respects the `limit` cap', () => {
    const lines: string[] = [];
    for (let i = 0; i < 60; i++) {
      lines.push(pino({ level: 50, ns: 'pi-runtime', workerId: 'w-1', msg: `err ${i}` }));
    }
    writeCore(lines);
    const result = readLog({
      neuraHome,
      source: { kind: 'core' },
      workerId: 'w-1',
      limit: 10,
    });
    expect(result.entries).toHaveLength(10);
    expect(result.entries[result.entries.length - 1].msg).toBe('err 59');
  });

  it('signals truncation when tail window cuts matching entries', () => {
    // Write a large number of matching lines and request a tiny tail.
    const lines: string[] = [];
    for (let i = 0; i < 100; i++) {
      lines.push(
        pino({
          level: 50,
          ns: 'pi-runtime',
          workerId: 'w-1',
          msg: `err ${String(i).padStart(4, '0')}`,
        })
      );
    }
    writeCore(lines);
    const result = readLog({
      neuraHome,
      source: { kind: 'core' },
      workerId: 'w-1',
      tailBytes: 1024,
    });
    expect(result.truncated).toBe(true);
  });

  it('handles an empty file', () => {
    writeFileSync(join(neuraHome, 'logs', 'core.log'), '');
    const result = readLog({ neuraHome, source: { kind: 'core' } });
    expect(result.available).toBe(true);
    expect(result.entries).toEqual([]);
  });

  it('handles a file smaller than the tail window', () => {
    writeCore([pino({ level: 50, ns: 'x', msg: 'tiny' })]);
    const result = readLog({
      neuraHome,
      source: { kind: 'core' },
      tailBytes: 1024 * 1024,
    });
    expect(result.available).toBe(true);
    expect(result.truncated).toBe(false);
  });

  it('keeps the first line when the tail window starts exactly on a newline', () => {
    // Construct lines sized so the byte offset cleanly lands on a
    // newline boundary. Previously the reader dropped the first line
    // unconditionally on truncation, which silently lost a valid
    // entry when the offset was aligned.
    const lineA = pino({ level: 50, ns: 'x', workerId: 'w-1', msg: 'AAAA first' });
    const lineB = pino({ level: 50, ns: 'x', workerId: 'w-1', msg: 'BBBB second' });
    const lineC = pino({ level: 50, ns: 'x', workerId: 'w-1', msg: 'CCCC third' });
    writeCore([lineA, lineB, lineC]);
    // Size the tail window to start exactly after lineA's trailing \n.
    const windowBytes = Buffer.byteLength(lineB) + 1 + Buffer.byteLength(lineC) + 1;
    const result = readLog({
      neuraHome,
      source: { kind: 'core' },
      workerId: 'w-1',
      tailBytes: windowBytes,
    });
    expect(result.entries.map((e) => e.msg).sort()).toEqual(['BBBB second', 'CCCC third']);
  });
});

describe('readLog — parsing edge cases', () => {
  it('strips desktop [stdout] / [stderr] prefixes before JSON parsing', () => {
    // The Electron launcher writes `[stdout] {json}` per line. The
    // reader must unwrap the prefix so structured fields survive.
    writeCore([
      `[stdout] ${pino({ level: 50, ns: 'pi-runtime', workerId: 'w-1', msg: 'boom' })}`,
      `[stderr] ${pino({ level: 50, ns: 'pi-runtime', workerId: 'w-1', msg: 'bang' })}`,
    ]);
    const result = readLog({ neuraHome, source: { kind: 'core' }, workerId: 'w-1' });
    expect(result.entries).toHaveLength(2);
    for (const e of result.entries) {
      expect(e.kind).toBe('json');
      expect(e.level).toBe('error');
    }
    expect(result.entries.map((e) => e.msg).sort()).toEqual(['bang', 'boom']);
  });

  it('parses CRLF-delimited session files (pi on Windows)', () => {
    const path = join(neuraHome, 'agent', 'sessions', 'crlf.jsonl');
    writeFileSync(
      path,
      [
        JSON.stringify({ type: 'message', content: 'line one' }),
        JSON.stringify({ type: 'message', content: 'line two' }),
      ].join('\r\n') + '\r\n'
    );
    const result = readLog({
      neuraHome,
      source: { kind: 'session', sessionFile: 'crlf.jsonl' },
      minLevel: 'trace',
    });
    expect(result.entries.map((e) => e.msg)).toEqual(['line one', 'line two']);
  });

  it('rejects a symlink inside the allow-list whose target escapes it', async () => {
    const { symlink } = await import('node:fs/promises');
    // Target is outside the allow-listed roots but still inside the
    // neuraHome scratch dir — a realistic attack where an attacker
    // creates a symlink pointing at a sibling file.
    const target = join(neuraHome, 'secret.txt');
    writeFileSync(target, 'shh');
    const linkPath = join(neuraHome, 'logs', 'escape.log');
    await symlink(target, linkPath);
    const result = readLog({ neuraHome, path: 'logs/escape.log' });
    expect(result.available).toBe(false);
    expect(result.error).toMatch(/outside allowed log roots/);
  });
});
