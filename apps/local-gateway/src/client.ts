/**
 * Minimal local client (used by tests today; the real hook shims will use
 * the same framing). Signs envelope frames and correlates responses by
 * requestId. No secret ever leaves the process beyond the signed digest.
 */
import { randomBytes } from 'node:crypto';
import { connect, type Socket } from 'node:net';
import {
  buildLocalEnvelope,
  PROTOCOL_VERSION,
  type InboundMessage,
  type ResponseFrame,
} from '@raag/protocol';
import type { Clock } from '@raag/domain';

export class GatewayClient {
  #socket: Socket;
  #buffer = '';
  #pending: ((frame: ResponseFrame) => void)[] = [];
  #frames: string[] = [];
  #closed = false;

  private constructor(socket: Socket) {
    this.#socket = socket;
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      this.#buffer += chunk;
      let nl = this.#buffer.indexOf('\n');
      while (nl >= 0) {
        const line = this.#buffer.slice(0, nl);
        this.#buffer = this.#buffer.slice(nl + 1);
        if (line.length > 0) {
          const waiter = this.#pending.shift();
          if (waiter !== undefined) waiter(JSON.parse(line) as ResponseFrame);
          else this.#frames.push(line);
        }
        nl = this.#buffer.indexOf('\n');
      }
    });
    socket.on('close', () => {
      this.#closed = true;
    });
    socket.on('error', () => {
      this.#closed = true;
    });
  }

  static connect(ipcPath: string): Promise<GatewayClient> {
    return new Promise((resolve, reject) => {
      const socket = connect({ path: ipcPath });
      const client = new GatewayClient(socket);
      socket.once('connect', () => resolve(client));
      socket.once('error', (error) => reject(error));
    });
  }

  get isOpen(): boolean {
    return !this.#closed && !this.#socket.destroyed;
  }

  /** Submit a wire message with a fresh envelope; resolves on the FIRST
   * response frame (later terminal pushes: drainFrames()). */
  async send(
    key: string,
    clock: Clock,
    message: InboundMessage,
    timeoutMs = 5_000,
  ): Promise<ResponseFrame> {
    // hex: first char always alnum → satisfies NONCE_PATTERN ([^A-Za-z0-9] start would
    // be rejected by the gateway's envelope validation)
    const nonce = randomBytes(12).toString('hex'); // 24 chars, stable shape
    const ts = clock.now();
    const rawLine = buildLocalEnvelope(key, message, ts, nonce);
    this.#socket.write(rawLine + '\n');
    return await Promise.race([
      this.#nextFrame(),
      new Promise<never>((_, rejectFn) => {
        const timer = setTimeout(() => rejectFn(new Error('client response timeout')), timeoutMs);
        timer.unref();
      }),
    ]);
  }

  /** Frames that arrived without a queued request (terminal pushes). */
  drainFrames(): readonly string[] {
    const out = this.#frames;
    this.#frames = [];
    return out;
  }

  /** Wait for the next frame (e.g. an async terminal push). */
  async receive(timeoutMs = 5_000): Promise<ResponseFrame> {
    return await Promise.race([
      this.#nextFrame(),
      new Promise<never>((_, rejectFn) => {
        const t = setTimeout(() => rejectFn(new Error('client receive timeout')), timeoutMs);
        t.unref();
      }),
    ]);
  }

  #nextFrame(): Promise<ResponseFrame> {
    const buffered = this.#frames.shift();
    if (buffered !== undefined) return Promise.resolve(JSON.parse(buffered) as ResponseFrame);
    return new Promise((resolve) => this.#pending.push(resolve));
  }

  close(): void {
    this.#socket.destroy();
    this.#closed = true;
  }
}

void PROTOCOL_VERSION;
