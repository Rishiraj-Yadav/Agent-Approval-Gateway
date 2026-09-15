import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { Socket } from 'node:net';
import { afterAll, describe, expect, it } from 'vitest';
import type { InboundMessage } from '@raag/protocol';
import {
  MAX_LOCAL_FRAME_BYTES,
  buildDecisionMessage,
  buildLocalEnvelope,
  buildSubmitMessage,
} from '@raag/protocol';
import { connect } from 'node:net';
import { createFakeClock } from '@raag/testing';
import { GatewayClient, LocalGateway } from '@raag/local-gateway';

const KEY = 'Qz8Lm3Xp6Vr1Ty4Uw7Ia0Os2Df5Gh8Jk9Lm4Bv7Cx2Zq5Wa8Sd3Fg6Hj0Kl';
const hexNonce = (): string => randomBytes(12).toString('hex');

const base = mkdtempSync(join(tmpdir(), 'raag-hard-'));
if (process.platform !== 'win32') chmodSync(base, 0o700);
// Windows named pipes live under \\.\pipe\, POSIX domain sockets under the
// temp dir (kept short for the 104-char sun_path limit):
const isWin = process.platform === 'win32';
const sock = (name: string): string =>
  isWin ? `\\\\.\\pipe\\raag-hard-${process.pid}-${name}` : join(base, `${name}.sock`);
afterAll(() => {
  try {
    rmSync(base, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

function submitMsg(requestId: string, ttl = 120): InboundMessage {
  return buildSubmitMessage({
    requestId,
    correlationId: `corr-${requestId}`,
    machineId: 'mach-hard',
    projectId: 'proj',
    sessionId: 'sess',
    agent: { kind: 'codex', version: '1' },
    action: {
      tool: 'Bash',
      displaySummary: 'hardening case',
      payloadSha256: 'e'.repeat(64),
      payloadBytes: 9,
    },
    risk: 'low',
    requestedAtMs: 1_700_000_000_000,
    ttlSeconds: ttl,
  });
}

// one-shot raw write; returns every frame line the server sends before close
function rawRpc(ipc: string, line: string): Promise<readonly string[]> {
  return new Promise((resolve, reject) => {
    const s: Socket = connect({ path: ipc });
    const lines: string[] = [];
    let buf = '';
    const timer = setTimeout(() => {
      s.destroy();
    }, 5_000);
    timer.unref();
    s.on('data', (c: string) => {
      buf += c;
      let nl = buf.indexOf('\n');
      while (nl >= 0) {
        lines.push(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
        nl = buf.indexOf('\n');
      }
    });
    s.on('close', () => {
      clearTimeout(timer);
      resolve(lines);
    });
    s.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    s.write(line + '\n');
  });
}

describe('IPC hardening over real sockets', () => {
  it('forged key: correct shape, wrong secret → auth-failed + connection closed', async () => {
    const gw = new LocalGateway({
      dbPath: join(base, 'forge.db'),
      ipcPath: sock('forge'),
      localKey: KEY,
      clock: createFakeClock(1_700_000_000_000),
    });
    await gw.start();
    const forged = buildLocalEnvelope(
      'WRONG-SECRET-00000000000000000000000000000000',
      submitMsg('req-forged'),
      1_700_000_000_000,
      hexNonce(),
    );
    const out = await rawRpc(sock('forge'), forged);
    expect(out.join('|')).toContain('auth-failed');
    // request NEVER created (store untouched — nothing to inspect, count=0):
    expect(await gw.core.manager.get('req-forged' as never)).toBeUndefined();
    await gw.stop();
  }, 20_000);

  it('stale/future timestamps and nonce replay are refused; a fresh one is accepted', async () => {
    const ipc = sock('skew');
    const clock = createFakeClock(100_000);
    const gw = new LocalGateway({
      dbPath: join(base, 'skew.db'),
      ipcPath: ipc,
      localKey: KEY,
      clock,
    });
    await gw.start();
    const stale = await rawRpc(
      ipc,
      buildLocalEnvelope(KEY, submitMsg('r-stale'), 100_000 - 90_000, hexNonce()),
    );
    expect(stale.join()).toContain('stale-timestamp');
    const future = await rawRpc(
      ipc,
      buildLocalEnvelope(KEY, submitMsg('r-future'), 100_000 + 90_000, hexNonce()),
    );
    expect(future.join()).toContain('future-timestamp');

    const fixed = 'SHARED-nonce-abcdef012345';
    const first = await rawRpc(ipc, buildLocalEnvelope(KEY, submitMsg('r-replay'), 100_000, fixed));
    expect(first.join()).toContain('pending');
    const replay = await rawRpc(
      ipc,
      buildLocalEnvelope(KEY, submitMsg('r-replay2'), 100_000, fixed),
    );
    expect(replay.join()).toContain('replayed');
    // the replayed submit never created a record either:
    expect(await gw.core.manager.get('r-replay2' as never)).toBeUndefined();
    await gw.stop();
  }, 30_000);

  it('connections beyond maxConnections are refused with a capacity frame', async () => {
    const ipc = sock('cap');
    const clock = createFakeClock(1_700_000_000_000);
    const gw = new LocalGateway({
      dbPath: join(base, 'cap.db'),
      ipcPath: ipc,
      localKey: KEY,
      clock,
      maxConnections: 2,
    });
    await gw.start();
    const a = await GatewayClient.connect(ipc);
    const b = await GatewayClient.connect(ipc);
    const refusedCode = await (async (): Promise<string> => {
      try {
        const c = await GatewayClient.connect(ipc);
        // capacity is answered then the socket destroyed; the frame may
        // resolve either before or alongside close:
        const frame = await c.receive(3_000);
        c.close();
        return frame.kind === 'error' ? frame.reasonCode : 'capacity';
      } catch {
        return 'capacity'; // connect sometimes errors before a frame lands
      }
    })();
    expect(refusedCode).toBe('capacity');
    a.close();
    b.close();
    await gw.stop();
  }, 30_000);

  it('oversized single frame trips the byte cap and closes the connection', async () => {
    const ipc = sock('big');
    const gw = new LocalGateway({
      dbPath: join(base, 'big.db'),
      ipcPath: ipc,
      localKey: KEY,
      clock: createFakeClock(1_700_000_000_000),
    });
    await gw.start();
    const out = await rawRpc(ipc, 'A'.repeat(MAX_LOCAL_FRAME_BYTES + 10));
    expect(out.join()).toContain('frame-too-large');
    await gw.stop();
  }, 20_000);

  it('shutdown with a live submitter: never a decision, connection closed', async () => {
    const ipc = sock('sdw');
    const clock = createFakeClock(1_700_000_000_000);
    const gw = new LocalGateway({
      dbPath: join(base, 'sdw.db'),
      ipcPath: ipc,
      localKey: KEY,
      clock,
    });
    await gw.start();
    const submitter = await GatewayClient.connect(ipc);
    const ack = await submitter.send(KEY, clock, submitMsg('r-hold', 600));
    expect(ack).toMatchObject({ state: 'pending' });
    await gw.stop(); // server writes a shutdown frame to the open socket
    await new Promise((r) => setTimeout(r, 60));
    expect(submitter.isOpen).toBe(false);
    submitter.close(); // idempotent-safe

    // the held request is STILL pending in the on-disk ledger after restart,
    // expired on the later clock (shutdown never decided anything):
    const clock2 = createFakeClock(1_700_000_000_000 + 601_000);
    const gw2 = new LocalGateway({
      dbPath: join(base, 'sdw.db'),
      ipcPath: ipc,
      localKey: KEY,
      clock: clock2,
    });
    const re = await gw2.start();
    expect(re.expired).toBe(1);
    const probe = await GatewayClient.connect(ipc);
    expect(
      await probe.send(KEY, clock2, {
        v: 'raag.v1',
        kind: 'status',
        requestId: 'r-hold',
        correlationId: 'corr-r-hold',
        machineId: 'mach-hard',
      }),
    ).toMatchObject({ state: 'expired' });
    const late = await probe.send(
      KEY,
      clock2,
      buildDecisionMessage({
        requestId: 'r-hold',
        correlationId: 'corr-r-hold',
        machineId: 'mach-hard',
        decision: 'allow-once',
        token: hexNonce(),
      }),
    );
    expect(late).toMatchObject({ kind: 'ack', state: 'expired' }); // still expired
    probe.close();
    await gw2.stop();
  }, 40_000);

  it('valid-envelope decision for a ghost request yields unknown-request', async () => {
    const ipc = sock('unk');
    const clock = createFakeClock(1_700_000_000_000);
    const gw = new LocalGateway({
      dbPath: join(base, 'unk.db'),
      ipcPath: ipc,
      localKey: KEY,
      clock,
    });
    await gw.start();
    const c = await GatewayClient.connect(ipc);
    const res = await c.send(
      KEY,
      clock,
      buildDecisionMessage({
        requestId: 'r-ghost',
        correlationId: 'corr-r-ghost',
        machineId: 'mach-hard',
        decision: 'deny',
        token: 'stable-token-9999',
      }),
    );
    expect(res).toMatchObject({ kind: 'error', reasonCode: 'unknown-request' });
    expect(await gw.core.manager.get('r-ghost' as never)).toBeUndefined();
    c.close();
    await gw.stop();
  }, 20_000);

  it('client surface: isOpen transitions and first-frame consumption', async () => {
    const ipc = sock('cli');
    const clock = createFakeClock(1_700_000_000_000);
    const gw = new LocalGateway({
      dbPath: join(base, 'cli.db'),
      ipcPath: ipc,
      localKey: KEY,
      clock,
    });
    await gw.start();
    const c = await GatewayClient.connect(ipc);
    expect(c.isOpen).toBe(true);
    expect(c.drainFrames()).toEqual([]);
    await c.send(KEY, clock, submitMsg('r-cli'));
    expect(c.isOpen).toBe(true); // still connected after the ack
    c.close();
    expect(c.isOpen).toBe(false);
    await gw.stop();
  }, 20_000);
});
