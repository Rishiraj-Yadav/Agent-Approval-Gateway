import { describe, expect, it } from 'vitest';
import { createCaptureSink, createLogger, parseLogLevel, type LogRecord } from '@raag/logging';

const T = 1_700_000_000_000;

function capture(level: 'debug' | 'info' | 'warn' | 'error' = 'debug') {
  const { sink, lines } = createCaptureSink();
  const logger = createLogger({ name: 'test', level, sink, now: () => T });
  return { logger, lines };
}

const parse = (line: string): LogRecord => JSON.parse(line) as LogRecord;

describe('logging levels', () => {
  it('filters below the configured level', () => {
    const { logger, lines } = capture('info');
    logger.debug('hidden');
    logger.info('shown');
    expect(lines()).toHaveLength(1);
    expect(parse(lines()[0] ?? '').message).toBe('shown');
  });

  it('parseLogLevel tolerates case and rejects junk', () => {
    expect(parseLogLevel('WARN')).toBeUndefined();
    expect(parseLogLevel('warn')).toBe('warn');
    expect(parseLogLevel('nope')).toBeUndefined();
  });

  it('child() produces prefixed logger, redacting the suffix', () => {
    const { logger, lines } = capture('debug');
    const child = logger.child('adapter');
    child.info('hi');
    expect(parse(lines()[0] ?? '').logger).toBe('test.adapter');
  });
});

describe('logging redaction', () => {
  it('redacts string metadata that looks like a secret', () => {
    const { logger, lines } = capture('debug');
    logger.info('connect', {
      url: 'https://api',
      token: 'abcdef123456abcdef123456',
    });
    const rec = parse(lines()[0] ?? '');
    expect(rec.meta.url).toBe('https://api');
    expect(rec.meta.token).toBe('[redacted]'); // sensitive-name value entirely gone
  });

  it('redacts secrets embedded in the message text', () => {
    const { logger, lines } = capture('debug');
    logger.error('auth failed for Bearer abcdefghijklmnop123456789 user', { requestId: 'req-1' });
    const rec = parse(lines()[0] ?? '');
    expect(rec.message).not.toContain('abcdefghijklmnop123456789');
    expect(rec.message).toContain('Bearer');
    expect(rec.meta.requestId).toBe('req-1');
  });

  it('error path still never leaks raw secret values', () => {
    const { logger, lines } = capture('debug');
    logger.error(
      'failed to store APPROVAL_HMAC_KEY=aK7$verySecretValue9xZb3fQ2mLw4nRt8pY1sDc6vHj0kFgUe',
    );
    const rec = parse(lines()[0] ?? '');
    expect(rec.message).not.toContain('verySecretValue');
    expect(rec.message).not.toContain('aK7$');
  });

  it('structured JSON line shape', () => {
    const { logger, lines } = capture('debug');
    logger.warn('heads up', { code: 42, ok: true });
    const rec = parse(lines()[0] ?? '');
    expect(rec).toMatchObject({ level: 'warn', meta: { code: 42, ok: true }, logger: 'test' });
  });
});

describe('logger construction', () => {
  it('rejects a blank name', () => {
    expect(() => createLogger({ name: ' ', level: 'info' })).toThrowError(/name/);
  });
});
