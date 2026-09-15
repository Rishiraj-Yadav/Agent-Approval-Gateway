/**
 * Gateway composition root (main entry). Fail-closed bootstrap order:
 * config → key material → sqlite (migrate+integrity) → core → reconcile
 * startup → listen → sweeper. Any failure exits non-zero without serving.
 */
import { loadGatewayConfig } from '@raag/config';
import { millisOf, type Clock, type Millis } from '@raag/domain';
import { defaultIpcPath, LocalGateway } from './ipc-server.js';

const clock: Clock = { now: (): Millis => millisOf(Date.now()) };

export async function main(
  env: Record<string, string | undefined> = process.env,
): Promise<LocalGateway> {
  const config = loadGatewayConfig(env);
  const gateway = new LocalGateway({
    dbPath: config.storage.dbPath,
    ipcPath:
      config.gateway.ipcPath ??
      defaultIpcPath(process.platform, process.env.USER ?? process.env.USERNAME),
    localKey: config.gateway.localKey,
    clock,
    ...(config.gateway.sweepIntervalMs === undefined
      ? {}
      : { sweepIntervalMs: config.gateway.sweepIntervalMs }),
  });
  const report = await gateway.start();
  const pendingLine = report.stillPending > 0 ? `, ${report.stillPending} pending continue` : '';
  process.stdout.write(
    `raag local gateway listening (reconciled: ${report.expired} expired, ${report.abandoned} abandoned${pendingLine})\n`,
  );

  let stopping = false;
  const stopOnce = (): void => {
    if (stopping) return;
    stopping = true;
    void gateway
      .stop()
      .then(() => process.exit(0))
      .catch(() => process.exit(1));
  };
  process.on('SIGINT', stopOnce);
  process.on('SIGTERM', stopOnce);
  return gateway;
}
