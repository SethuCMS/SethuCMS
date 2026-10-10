/**
 * Process entry point for the all-in-one gateway.
 *
 * Reads config from the environment, starts the HTTP server, prints a
 * start-up banner on stderr (stdout stays clean) and shuts down cleanly
 * on SIGINT/SIGTERM.
 */
import { resolve } from 'node:path';
import { configFromEnv } from './config.js';
import { createGateway } from './gateway.js';

const config = configFromEnv(process.env);
// Absolute paths, so a later chdir cannot change where data lives.
if (config.dataDir) {
  config.dataDir = resolve(config.dataDir);
}
if (config.adminDir) {
  config.adminDir = resolve(config.adminDir);
}

const gateway = await createGateway({ config });
// Audit the start so restarts show up in the trail.
gateway.services.audit.record({
  actor: 'system',
  operation: 'gateway.start',
  target: 'gateway',
  detail: { production: config.production },
});
let address: { host: string; port: number };
try {
  address = await gateway.listen();
} catch (error) {
  // Give the data folder lock back, otherwise the next start is refused for 30
  // seconds.
  await gateway.close().catch(() => undefined);
  const code = (error as NodeJS.ErrnoException).code;
  process.stderr.write(
    code === 'EADDRINUSE'
      ? `\n  Port ${config.port} is already in use. Start SethuCMS on another port, for example:  PORT=${config.port + 10000 > 65535 ? 18080 : config.port + 10000} sh scripts/run-local.sh\n\n`
      : `\n  The gateway could not start listening: ${(error as Error).message}\n\n`,
  );
  process.exit(1);
}

// The admin token is printed only on first start and never logged, so it
// cannot leak into log aggregation.
const lines = [
  '',
  `  SethuCMS gateway is running at http://${address.host}:${address.port}`,
  config.adminDir
    ? `  Admin app:             http://${address.host}:${address.port}/`
    : '  Admin app:             not served (set SETHUCMS_ADMIN_DIR to the built admin folder)',
  config.firestore
    ? `  State:                 Firestore project ${config.firestore.projectId} (prefix ${config.firestore.prefix})`
    : config.stateUrl
      ? '  State:                 PostgreSQL (shared)'
      : config.dataDir
        ? `  Data folder:           ${config.dataDir}`
        : '  Data folder:           none (everything is kept in memory)',
  '',
];
if (gateway.generatedAdminToken) {
  lines.push(
    '  First start: an admin token was created. It is shown only once.',
    `  ADMIN TOKEN:           ${gateway.generatedAdminToken}`,
    '  Paste it on the sign-in screen. To use your own token, set SETHUCMS_ADMIN_TOKEN.',
    '',
  );
}
process.stderr.write(lines.join('\n'));

// Guard so a second signal during shutdown does not close twice.
let stopping = false;
const stop = async (): Promise<void> => {
  if (stopping) {
    return;
  }
  stopping = true;
  await gateway.close();
  process.exit(0);
};
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
