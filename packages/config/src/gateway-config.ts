import { DomainError } from '@raag/domain';

/**
 * @raag/config — validated environment configuration (ADR-017: no dotenv
 * package; Node 22 ships `process.loadEnvFile`, which is used only in the
 * entrypoint bootstrap layer; this module consumes plain string maps).
 *
 * FAIL CLOSED: parseConfig returns typed errors — NEVER a partial/defaulted
 * "usable" config when something required is absent or unsafe. Field names
 * only are ever mentioned in errors; values are not echoed (security.md §4).
 */
export const packageName = '@raag/config' as const;

export interface GatewayConfig {
  readonly telegram: {
    /** Raw token value — callers must treat as secret; never logs this. */
    readonly botToken: string;
    readonly allowedChatIds: readonly string[];
  };
  readonly security: {
    readonly approvalHmacKey: string;
  };
  readonly gateway: {
    /** Validated loopback literal. Non-loopback binds never reach callers. */
    readonly host: '127.0.0.1' | 'localhost' | '::1';
    readonly port: number;
    /** ADR-034: pipe/UDS mode is the default transport; the bearer-token-file
     * option (ADR-008 TCP fallback) is now optional. */
    readonly tokenFilePath?: string | undefined;
    /** Local IPC endpoint (named pipe / UDS path). Derived when absent. */
    readonly ipcPath?: string | undefined;
    /** HMAC key authenticating every local IPC frame (ADR-034). Required. */
    readonly localKey: string;
    /** Override for the expiry-sweep cadence; derived default in gateway. */
    readonly sweepIntervalMs?: number | undefined;
  };
  readonly approvals: {
    readonly ttlSeconds: number;
  };
  readonly storage: {
    readonly dbPath: string;
  };
  readonly relay?: {
    readonly url: string;
    readonly gatewayKey: string;
  };
  readonly logLevel: 'debug' | 'info' | 'warn' | 'error';
}

export interface ConfigError {
  readonly field: string;
  readonly reason: string;
}

export type ConfigResult =
  | { readonly ok: true; readonly config: GatewayConfig }
  | { readonly ok: false; readonly errors: readonly ConfigError[] };

const MIN_HMAC_BYTES = 32;
const MAX_TTL_SECONDS = 3_600;
const DEFAULT_TTL_SECONDS = 120;
const ALLOWED_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);
const WILDCARD_HOSTS = new Set(['0.0.0.0', '::']);
export const CONFIG_FIELD_NAMES = [
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_ALLOWED_CHAT_IDS',
  'APPROVAL_HMAC_KEY',
  'GATEWAY_HOST',
  'GATEWAY_PORT',
  'GATEWAY_IPC_PATH',
  'GATEWAY_TOKEN_FILE',
  'GATEWAY_LOCAL_KEY',
  'GATEWAY_SWEEP_MS',
  'APPROVAL_TTL_SECONDS',
  'GATEWAY_DB_PATH',
  'RELAY_URL',
  'RELAY_GATEWAY_KEY',
  'LOG_LEVEL',
] as const;

export const LOOPBACK_HOSTS: readonly string[] = [...ALLOWED_HOSTS];

export function parseConfig(env: Record<string, string | undefined>): ConfigResult {
  const errors: ConfigError[] = [];
  const fail = (field: string, reason: string): void => {
    errors.push({ field, reason });
  };

  const botToken = (env.TELEGRAM_BOT_TOKEN ?? '').trim();
  if (botToken.length === 0) {
    fail('TELEGRAM_BOT_TOKEN', 'required and must be non-empty');
  }

  const chatIdsRaw = (env.TELEGRAM_ALLOWED_CHAT_IDS ?? '').trim();
  const allowedChatIds = chatIdsRaw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (chatIdsRaw.length === 0) {
    fail(
      'TELEGRAM_ALLOWED_CHAT_IDS',
      'required: at least one operator chat id (bootstrap: send /start, read the logged numeric id, fill config manually — first-user auto-binding is rejected)',
    );
  }
  for (const id of allowedChatIds) {
    if (!/^\d{1,24}$/.test(id)) {
      fail('TELEGRAM_ALLOWED_CHAT_IDS', 'ids must be pure digits');
      break;
    }
  }

  const hmac = env.APPROVAL_HMAC_KEY ?? '';
  const hmacInfo = checkHmacEntropy(hmac);
  if (!hmacInfo.ok) {
    fail('APPROVAL_HMAC_KEY', hmacInfo.reason);
  }

  const hostRaw = (env.GATEWAY_HOST ?? '127.0.0.1').trim() || '127.0.0.1';
  let host: GatewayConfig['gateway']['host'] = '127.0.0.1';
  if (WILDCARD_HOSTS.has(hostRaw)) {
    fail(
      'GATEWAY_HOST',
      'wildcard binds are forbidden for the local gateway (architecture.md §9): use 127.0.0.1 or leave unset',
    );
  } else if (!ALLOWED_HOSTS.has(hostRaw)) {
    fail(
      'GATEWAY_HOST',
      'must be a loopback address (127.0.0.1 / localhost / ::1); the gateway never exposes itself beyond the machine',
    );
  } else {
    host = hostRaw as GatewayConfig['gateway']['host'];
  }

  const port = parseBoundedInt(env.GATEWAY_PORT, 'GATEWAY_PORT', 0, 65_535, 0, errors);
  const tokenFile = (env.GATEWAY_TOKEN_FILE ?? '').trim();
  const ipcPath = (env.GATEWAY_IPC_PATH ?? '').trim();
  if (
    ipcPath.length > 0 &&
    // eslint-disable-next-line no-control-regex
    (ipcPath.length > 260 || /[\u0000-\u001f\u007f]/.test(ipcPath))
  ) {
    fail(
      'GATEWAY_IPC_PATH',
      'when set must be <=260 printable chars (named pipe or absolute UDS path)',
    );
  }
  const localKey = env.GATEWAY_LOCAL_KEY ?? '';
  if (localKey.length === 0) {
    fail(
      'GATEWAY_LOCAL_KEY',
      'required: local gateway frames must be authenticated (ADR-034, fail closed)',
    );
  } else {
    const localInfo = checkHmacEntropy(localKey);
    if (!localInfo.ok) {
      fail('GATEWAY_LOCAL_KEY', localInfo.reason);
    }
  }

  const sweepRaw = (env.GATEWAY_SWEEP_MS ?? '').trim();
  const sweepIntervalMs =
    sweepRaw.length === 0
      ? undefined
      : parseBoundedInt(env.GATEWAY_SWEEP_MS, 'GATEWAY_SWEEP_MS', 100, 600_000, 0, errors);

  const ttl = parseBoundedInt(
    env.APPROVAL_TTL_SECONDS,
    'APPROVAL_TTL_SECONDS',
    1,
    MAX_TTL_SECONDS,
    DEFAULT_TTL_SECONDS,
    errors,
  );

  const dbPath = (env.GATEWAY_DB_PATH ?? '').trim();
  if (dbPath.length === 0) {
    fail('GATEWAY_DB_PATH', 'required: SQLite path');
  }

  const relayUrl = (env.RELAY_URL ?? '').trim();
  const relayKey = (env.RELAY_GATEWAY_KEY ?? '').trim();
  let relay: GatewayConfig['relay'] | undefined;
  if (relayUrl.length > 0 || relayKey.length > 0) {
    if (relayUrl.length === 0 || relayKey.length === 0) {
      fail('RELAY_URL/RELAY_GATEWAY_KEY', 'both must be set together or not at all');
    } else if (!/^https:\/\//.test(relayUrl)) {
      fail(
        'RELAY_URL',
        'must be an https:// endpoint (TLS is mandatory; ssh tunnels are configured at the transport level, not here)',
      );
    } else if (relayKey.length < MIN_HMAC_BYTES) {
      fail('RELAY_GATEWAY_KEY', `must be at least ${MIN_HMAC_BYTES} characters`);
    } else {
      relay = { url: relayUrl, gatewayKey: relayKey };
    }
  }

  const logLevelRaw = (env.LOG_LEVEL ?? 'info').trim().toLowerCase();
  const logLevels = ['debug', 'info', 'warn', 'error'] as const;
  const logLevel = (logLevels as readonly string[]).includes(logLevelRaw)
    ? (logLevelRaw as GatewayConfig['logLevel'])
    : undefined;
  if (logLevel === undefined) {
    fail('LOG_LEVEL', 'must be debug|info|warn|error');
  }

  const portValue = port ?? 0;
  const ttlValue = ttl ?? DEFAULT_TTL_SECONDS;

  if (errors.length > 0) {
    return { ok: false, errors: freezeAndDedupe(errors) };
  }

  return {
    ok: true,
    config: {
      telegram: { botToken, allowedChatIds },
      security: { approvalHmacKey: hmac },
      gateway: {
        host,
        port: portValue,
        ...(tokenFile.length === 0 ? {} : { tokenFilePath: tokenFile }),
        ...(ipcPath.length === 0 ? {} : { ipcPath }),
        ...(sweepIntervalMs === undefined ? {} : { sweepIntervalMs }),
        localKey,
      },
      approvals: { ttlSeconds: ttlValue },
      storage: { dbPath },
      ...(relay === undefined ? {} : { relay }),
      logLevel: logLevel ?? 'info',
    },
  };
}

/**
 * Fail-closed convenience: returns the config or throws with field names only.
 */
export function loadGatewayConfig(env: Record<string, string | undefined>): GatewayConfig {
  const result = parseConfig(env);
  if (result.ok) return result.config;
  throw new DomainError(
    'invalid-config',
    result.errors.map((e) => e.field).join(','),
    'gateway configuration invalid (fail closed)',
  );
}

/** Shannon entropy (bits/char); the documented minimum is 3.5 over ≥32 chars. */
const MIN_HMAC_BITS_PER_CHAR = 3.5;

export interface HmacCheck {
  readonly ok: boolean;
  readonly reason: string;
}

/** Exported for tests + reuse by security-sensitive call sites that accept a raw key. */
export function checkHmacEntropy(key: string): HmacCheck {
  if (key.length === 0) {
    return { ok: false, reason: 'required: HMAC key missing from environment' };
  }
  if (key.length < MIN_HMAC_BYTES) {
    return {
      ok: false,
      reason: `must be at least ${MIN_HMAC_BYTES} characters (key length only, value not shown)`,
    };
  }
  if (/^(.)\1*$/.test(key)) {
    return { ok: false, reason: 'too uniform to be a key: single repeated character' };
  }
  if (/\b(change|me|replace|dev|test|example|password|secret|abc123|123456|xxxx)\b/i.test(key)) {
    return { ok: false, reason: 'looks like a placeholder default, not a generated key' };
  }
  const counts = new Map<string, number>();
  for (const ch of key) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  const entropy = [...counts.values()].reduce(
    (acc, c) => acc - (c / key.length) * Math.log2(c / key.length),
    0,
  );
  if (entropy < MIN_HMAC_BITS_PER_CHAR) {
    return {
      ok: false,
      reason: `insufficient entropy: minimum ${MIN_HMAC_BITS_PER_CHAR} bits/char over at least ${MIN_HMAC_BYTES} characters, value never shown`,
    };
  }
  return { ok: true, reason: '' };
}

function parseBoundedInt(
  raw: string | undefined,
  field: string,
  min: number,
  max: number,
  fallback: number,
  errors: ConfigError[],
): number | undefined {
  const trimmed = (raw ?? '').trim();
  if (trimmed.length === 0) return fallback;
  const n = Number(trimmed);
  if (!Number.isInteger(n) || n < min || n > max) {
    errors.push({ field, reason: `must be an integer between ${min} and ${max}` });
    return undefined;
  }
  return n;
}

function freezeAndDedupe(errors: ConfigError[]): readonly ConfigError[] {
  const seen = new Set<string>();
  const out: ConfigError[] = [];
  for (const e of errors) {
    const key = `${e.field}|${e.reason}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(e);
    }
  }
  return Object.freeze(out);
}
