/**
 * IPC server for the local gateway (ADR-034):
 *
 *  - Windows: named pipe (\\.\pipe\raag-<user>) — per-session namespace +
 *    default creator-owner ACL;
 *  - POSIX:   unix domain socket, chmod 0600 after bind (no TCP, so no port
 *    exposure and no firewall surface — stronger than ADR-008's loopback TCP).
 *
 * Frames: NDJSON lines; over-cap or auth-failed closes the connection
 * (attack traffic gets no persistent channel).
 */
import { chmodSync, existsSync, unlinkSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { openSqliteStore, type SqliteStore } from '@raag/database';
import { MAX_LOCAL_FRAME_BYTES } from '@raag/protocol';
import type { Clock } from '@raag/domain';

import { GatewayCore, DEFAULT_SWEEP_INTERVAL_MS, MAX_CONNECTIONS } from './gateway-core.js';
import { defaultIpcPath } from './ipc-default.js';

export interface LocalGatewayOptions {
  readonly dbPath: string;
  readonly ipcPath: string;
  readonly localKey: string;
  readonly clock: Clock;
  readonly sweepIntervalMs?: number | undefined;
  /** §28 resource bound; override is test-only (default MAX_CONNECTIONS). */
  readonly maxConnections?: number | undefined;
}

export class LocalGateway {
  #store: SqliteStore;
  #core: GatewayCore;
  #server: Server | null = null;
  #sockets = new Set<Socket>();
  #sweepTimer: ReturnType<typeof setInterval> | null = null;
  readonly #path: string;
  readonly #sweepIntervalMs: number;
  readonly #maxConnections: number;
  #stopped = false;

  constructor(opts: LocalGatewayOptions) {
    this.#path = opts.ipcPath;
    this.#sweepIntervalMs = opts.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
    this.#maxConnections = opts.maxConnections ?? MAX_CONNECTIONS;
    this.#store = openSqliteStore({ path: opts.dbPath, clock: opts.clock });
    this.#core = new GatewayCore({
      store: this.#store,
      localKey: opts.localKey,
      clock: opts.clock,
    });
  }

  get path(): string {
    return this.#path;
  }

  get core(): GatewayCore {
    return this.#core;
  }

  /** Open (after migrate/reconcile), listen, start sweeper. */
  async start(): Promise<{
    expired: number;
    abandoned: number;
    stillPending: number;
  }> {
    const reconciliation = await this.#core.reconcileStartup();
    const server = createServer((socket) => {
      this.#onConnection(socket);
    });
    server.on('error', (error) => {
      // fail closed: never keep serving with a broken listener
      this.#fatal = error;
    });
    await this.#listen(server);
    this.#server = server;
    if (process.platform !== 'win32') {
      try {
        chmodSync(this.#path, 0o600);
      } catch {
        await this.stop();
        throw new Error('gateway socket chmod failed — refusing to serve world-accessible IPC');
      }
    }
    this.#sweepTimer = setInterval(() => {
      void this.#core.sweep().catch(() => this.stop());
    }, this.#sweepIntervalMs);
    this.#sweepTimer.unref();
    return {
      expired: reconciliation.expired,
      abandoned: reconciliation.abandoned,
      stillPending: reconciliation.stillPending,
    };
  }

  #fatal: Error | null = null;

  async stop(): Promise<void> {
    if (this.#stopped) return;
    this.#stopped = true;
    this.#core.beginShutdown();
    if (this.#sweepTimer !== null) clearInterval(this.#sweepTimer);
    for (const socket of this.#sockets) {
      try {
        socket.write('{"v":"raag.v1","kind":"error","reasonCode":"shutdown"}\n');
      } catch {
        /* already gone */
      }
      socket.destroy();
    }
    this.#sockets.clear();
    if (this.#server !== null) {
      await new Promise<void>((resolve) => {
        this.#server?.close(() => resolve());
        // sockets destroyed above → close completes
      });
    }
    this.#store.close();
    if (this.#fatal !== null) {
      throw this.#fatal;
    }
  }

  async #listen(server: Server): Promise<void> {
    try {
      await once(server, this.#path);
    } catch (error) {
      // POSIX residual socket file from a previous crash: unlink ONCE, retry.
      if (!isAddrInUse(error) || process.platform === 'win32') throw error;
      try {
        if (existsSync(this.#path)) unlinkSync(this.#path);
      } catch {
        throw error;
      }
      await once(server, this.#path);
    }
  }

  #onConnection(socket: Socket): void {
    if (this.#core.closing) {
      socket.destroy();
      return;
    }
    if (this.#sockets.size >= this.#maxConnections) {
      try {
        socket.write('{"v":"raag.v1","kind":"error","reasonCode":"capacity"}\n');
      } catch {
        /* ignore */
      }
      socket.destroy();
      return;
    }
    this.#sockets.add(socket);
    socket.setEncoding('utf8');
    let buffer = '';
    socket.on('data', (chunk: string) => {
      if (this.#core.closing) {
        socket.destroy();
        return;
      }
      buffer += chunk;
      if (Buffer.byteLength(buffer, 'utf8') > MAX_LOCAL_FRAME_BYTES * 4) {
        buffer = '';
        try {
          socket.write('{"v":"raag.v1","kind":"error","reasonCode":"frame-too-large"}\n');
        } catch {
          /* ignore */
        }
        socket.destroy();
        return;
      }
      let nl = buffer.indexOf('\n');
      while (nl >= 0) {
        const line = buffer.slice(0, nl).replace(/\r$/, '');
        buffer = buffer.slice(nl + 1);
        void this.#handleLine(socket, line);
        nl = buffer.indexOf('\n');
      }
    });
    socket.on('error', () => socket.destroy());
    socket.on('close', () => this.#sockets.delete(socket));
  }

  async #handleLine(socket: Socket, line: string): Promise<void> {
    if (socket.destroyed) return;
    const decision = await this.#core.handleLine(line, (frame) => {
      if (!socket.destroyed) socket.write(frame);
    });
    if (decision === 'close') socket.destroy();
  }
}

function once(server: Server, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onListening = (): void => {
      server.off('error', onError);
      resolve();
    };
    const onError = (error: Error): void => {
      server.off('listening', onListening);
      reject(error);
    };
    server.once('listening', onListening);
    server.once('error', onError);
    server.listen({ path, exclusive: true });
  });
}

function isAddrInUse(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    String((error as { code?: unknown }).code) === 'EADDRINUSE'
  );
}

export { defaultIpcPath };
