import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import type { InboundMessage } from '@raag/protocol';
import { buildDecisionMessage, buildSubmitMessage } from '@raag/protocol';
import { createFakeClock } from '@raag/testing';
import { GatewayClient, LocalGateway } from '@raag/local-gateway';

/** ≥32 printable, non-placeholder so config/entropy rules are satisfied. */
const KEY = 'Qz8Lm3Xp6Vr1Ty4Uw7Ia0Os2Df5Gh8Jk9Lm4Bv7Cx2Zq5Wa8Sd3Fg6Hj0Kl';

function nonce(): string {
  return randomBytes(12).toString('hex'); // alnum first char (see NONCE_PATTERN)
}

type Clock = ReturnType<typeof createFakeClock>;

function submit(clock: Clock, requestId: string): InboundMessage {
  return buildSubmitMessage({
    requestId,
    correlationId: `corr-${requestId}`,
    machineId: 'mach-ipc',
    projectId: 'proj-ipc',
    sessionId: 'sess-ipc',
    agent: { kind: 'codex', version: '9' },
    action: {
      tool: 'Bash',
      displaySummary: 'run: git status',
      payloadSha256: 'd'.repeat(64),
      payloadBytes: 12,
    },
    risk: 'low',
    requestedAtMs: clock.now(),
    ttlSeconds: 30,
  });
}

const base = mkdtempSync(join(tmpdir(), 'raag-ipc-'));
if (process.platform !== 'win32') chmodSync(base, 0o700);
const ipcPath =
  process.platform === 'win32' ? `\\\\.\\pipe\\raag-it-${process.pid}` : join(base, 'g.sock'); // short path keeps macOS/Solaris 104-char limits safe too

function statusLine(_clock: Clock, requestId: string): InboundMessage {
  return {
    v: 'raag.v1',
    kind: 'status',
    requestId,
    correlationId: `corr-${requestId}`,
    machineId: 'mach-ipc',
  };
}

afterAll(() => {
  try {
    rmSync(base, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

async function rawWrite(path: string, data: string): Promise<string> {
  const { connect } = await import('node:net');
  return await new Promise((resolve, reject) => {
    const s = connect({ path });
    let out = '';
    const t = setTimeout(() => s.destroy(), 5_000);
    t.unref();
    s.on('data', (c: string) => {
      out += c;
      s.destroy();
    });
    s.on('close', () => resolve(out));
    s.on('error', reject);
    s.write(data);
  });
}

describe('LocalGateway over real IPC (named pipe / unix socket)', () => {
  it('submit → cross-connection decision → persisted; restart: approved survives, stale pending expires (never approves)', async () => {
    const dbPath = join(base, 'lifecycle.db');
    const clock = createFakeClock(1_700_000_000_000);
    const gw = new LocalGateway({ dbPath, ipcPath, localKey: KEY, clock });
    expect((await gw.start()).expired).toBe(0);

    const submitter = await GatewayClient.connect(ipcPath);
    const ack = await submitter.send(KEY, clock, submit(clock, 'req-ipc-1'));
    expect(ack).toMatchObject({ kind: 'ack', state: 'pending' });

    const decider = await GatewayClient.connect(ipcPath);
    const dres = await decider.send(
      KEY,
      clock,
      buildDecisionMessage({
        requestId: 'req-ipc-1',
        correlationId: 'corr-req-ipc-1',
        machineId: 'mach-ipc',
        decision: 'allow-once',
        token: nonce() || 'tok123456',
      }),
    );
    expect(dres).toMatchObject({ kind: 'ack', state: 'approved' });

    // terminal push arrives ONLY on the submitter connection:
    const pushed = await submitter.receive();
    expect(pushed).toMatchObject({ requestId: 'req-ipc-1', state: 'approved' });

    submitter.close();
    decider.close();
    await gw.stop();

    // RESTART 60s later: the approved row is untouched (never re-pending);
    // any stale pending expires deny-side, never approve.
    const clock2 = createFakeClock(1_700_000_060_000);
    const gw2 = new LocalGateway({ dbPath, ipcPath, localKey: KEY, clock: clock2 });
    const re = await gw2.start();
    expect(re.expired).toBe(0);
    const probe = await GatewayClient.connect(ipcPath);
    expect(await probe.send(KEY, clock2, statusLine(clock2, 'req-ipc-1'))).toMatchObject({
      state: 'approved',
    });
    const lateAllow = await probe.send(
      KEY,
      clock2,
      buildDecisionMessage({
        requestId: 'req-ipc-1',
        correlationId: 'corr-req-ipc-1',
        machineId: 'mach-ipc',
        decision: 'deny',
        token: 'lateattempt1234',
      }),
    );
    // post-restart late decision on an approved row must NOT flip it:
    expect(lateAllow).toMatchObject({ state: 'approved' });
    probe.close();
    await gw2.stop();
  }, 30_000);

  it('unauthenticated raw bytes are refused and fail closed with a parse-failed + close', async () => {
    const dbPath = join(base, 'auth.db');
    const clock = createFakeClock(1_700_000_000_000);
    const gw = new LocalGateway({ dbPath, ipcPath, localKey: KEY, clock });
    await gw.start();
    const raw = await rawWrite(ipcPath, 'hello, definitely not json\n');
    expect(raw).toMatch(/parse-failed/);
    // nothing persisted, audit empty:
    const c = await GatewayClient.connect(ipcPath);
    const st = await c
      .send(KEY, clock, statusLine(clock, 'req-nothing-here'))
      .catch(() => undefined);
    expect(st).toMatchObject({ reasonCode: 'unknown-request' });
    c.close();
    await gw.stop();
  }, 20_000);

  it('shutdown while pending: row stays persisted, restart expires it by TTL (never auto-decided)', async () => {
    const dbPath = join(base, 'shutdown.db');
    const clock = createFakeClock(1_700_000_000_000);
    const gw = new LocalGateway({ dbPath, ipcPath, localKey: KEY, clock });
    await gw.start();
    const client = await GatewayClient.connect(ipcPath);
    const ack = await client.send(KEY, clock, submit(clock, 'req-hold'));
    expect(ack).toMatchObject({ state: 'pending' });
    client.close();
    await gw.stop();

    const clock2 = createFakeClock(1_700_000_000_000 + 45_000); // past 30s ttl
    const gw2 = new LocalGateway({ dbPath, ipcPath, localKey: KEY, clock: clock2 });
    const re = await gw2.start();
    expect(re.expired).toBe(1);
    const p = await GatewayClient.connect(ipcPath);
    expect(await p.send(KEY, clock2, statusLine(clock2, 'req-hold'))).toMatchObject({
      state: 'expired',
    });
    // even an explicit post-shutdown allow cannot resurrect it:
    const late = await p.send(
      KEY,
      clock2,
      buildDecisionMessage({
        requestId: 'req-hold',
        correlationId: 'corr-req-hold',
        machineId: 'mach-ipc',
        decision: 'allow-once',
        token: 'resurrectatempt1',
      }),
    );
    expect(late).toMatchObject({ state: 'expired' });
    p.close();
    await gw2.stop();
  }, 30_000);
});
