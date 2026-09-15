import { describe, expect, it } from 'vitest';
import { checkHmacEntropy, parseConfig, type GatewayConfig } from '@raag/config';

const GOOD_KEY = 'a7Cf39Dx!Qe12Rt5Yu8Io0Pa4Sd7Fg2Hj6Kl9Zn2Bv5'; // 47 chars randomish

function over(rides: Partial<Record<string, string>>): Record<string, string | undefined> {
  return {
    TELEGRAM_BOT_TOKEN: '123:AAHxyzxyzxyzxyzxyzxyzxyzxyzxyzxyz',
    TELEGRAM_ALLOWED_CHAT_IDS: '555123456',
    APPROVAL_HMAC_KEY: GOOD_KEY,
    GATEWAY_TOKEN_FILE: './data/gateway.token',
    GATEWAY_DB_PATH: './data/gateway.db',
    LOG_LEVEL: 'info',
    ...rides,
  };
}

function ok(rides: Partial<Record<string, string>> = {}): GatewayConfig {
  const r = parseConfig(over(rides));
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  return r.config;
}

describe('parseConfig — valid', () => {
  it('accepts a complete safe configuration with defaults', () => {
    const c = ok();
    expect(c.gateway.host).toBe('127.0.0.1');
    expect(c.gateway.port).toBe(0);
    expect(c.approvals.ttlSeconds).toBe(120); // spec default
    expect(c.logLevel).toBe('info');
    expect(c.relay).toBeUndefined();
    expect(c.telegram.allowedChatIds).toEqual(['555123456']);
  });

  it('accepts each loopback spelling', () => {
    for (const h of ['127.0.0.1', 'localhost', '::1']) {
      expect(ok({ GATEWAY_HOST: h }).gateway.host).toBe(h);
    }
  });
});

describe('parseConfig — fail closed on unsafe/invalid', () => {
  it('rejects wildcard / routable bind addresses and explains why', () => {
    for (const bad of ['0.0.0.0', '::', '192.168.1.5', 'evil.example.com']) {
      const r = parseConfig(over({ GATEWAY_HOST: bad }));
      expect(r.ok, bad).toBe(false);
      if (!r.ok) {
        expect(JSON.stringify(r)).toContain('GATEWAY_HOST');
        expect(r.errors.some((e) => /loopback|wildcard/i.test(e.reason))).toBe(true);
      }
    }
  });

  it('rejects missing required fields — no partial config on offer', () => {
    const r = parseConfig({});
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const fields = r.errors.map((e) => e.field);
      expect(fields).toContain('TELEGRAM_BOT_TOKEN');
      expect(fields).toContain('APPROVAL_HMAC_KEY');
      expect(fields).toContain('GATEWAY_TOKEN_FILE');
      expect(fields).toContain('GATEWAY_DB_PATH');
    }
  });

  it('never echoes secret values in errors', () => {
    const leakyEnv = over({
      APPROVAL_HMAC_KEY: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', // 36 uniform: entropy-check rejects
      TELEGRAM_BOT_TOKEN: '',
    });
    const r = parseConfig(leakyEnv);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(JSON.stringify(r.errors)).not.toContain('aaaaaaaa');
    }
  });

  it('short, uniform, placeholder, and low-entropy keys are rejected', () => {
    expect(checkHmacEntropy('').ok).toBe(false);
    expect(checkHmacEntropy('short').ok).toBe(false);
    expect(checkHmacEntropy('a'.repeat(64)).ok).toBe(false);
    expect(checkHmacEntropy('change-me-please-and-store-32+chars').ok).toBe(false);
    expect(checkHmacEntropy('0123456789'.repeat(5)).ok).toBe(false);
    expect(checkHmacEntropy(GOOD_KEY).ok).toBe(true);
  });

  it('rejects malformed TTL, port, log level, chat ids, relay halves', () => {
    expect(parseConfig(over({ APPROVAL_TTL_SECONDS: '0' })).ok).toBe(false);
    expect(parseConfig(over({ APPROVAL_TTL_SECONDS: '4000' })).ok).toBe(false);
    expect(parseConfig(over({ APPROVAL_TTL_SECONDS: '12.5' })).ok).toBe(false);
    expect(parseConfig(over({ GATEWAY_PORT: '99999' })).ok).toBe(false);
    expect(parseConfig(over({ LOG_LEVEL: 'verbose' })).ok).toBe(false);
    expect(parseConfig(over({ TELEGRAM_ALLOWED_CHAT_IDS: 'abc' })).ok).toBe(false);
    expect(parseConfig(over({ RELAY_URL: 'https://x' })).ok).toBe(false); // key missing
    expect(parseConfig(over({ RELAY_URL: 'http://x', RELAY_GATEWAY_KEY: GOOD_KEY })).ok).toBe(
      false,
    ); // non-TLS relay
  });

  it('accepts a full relay section with https', () => {
    const c = ok({ RELAY_URL: 'https://relay.example:8443', RELAY_GATEWAY_KEY: GOOD_KEY });
    expect(c.relay?.url).toBe('https://relay.example:8443');
  });
});

describe('DomainError from loadGatewayConfig', () => {
  it('loadGatewayConfig throws naming fields only, never values', async () => {
    const { loadGatewayConfig } = await import('@raag/config');
    const bad = over({ APPROVAL_HMAC_KEY: 'x'.repeat(40) });
    let caught: Error | undefined;
    try {
      loadGatewayConfig(bad);
    } catch (error) {
      caught = error as Error;
    }
    expect(caught?.message).toMatch(/invalid-config/);
    expect(caught?.message).toMatch(/APPROVAL_HMAC_KEY/);
    expect(caught?.message).not.toContain('xxxxx');
  });
});
