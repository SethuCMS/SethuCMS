/**
 * Cross-language check: a Python adapter server (sethucms-adapter-sdk/examples/python-minimal)
 * must pass the same conformance suite. Skipped unless python3 with grpcio and grpcio-tools is available.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { GrpcAdapter } from '@sethucms/adapter-sdk/grpc';
import { defineConformanceSuite } from '@sethucms/adapter-sdk/testing';

const SERVER = fileURLToPath(
  new URL(
    '../../../../../sethucms-adapter-sdk/examples/python-minimal/server.py',
    import.meta.url,
  ),
);
const TOKEN = 'python-shared-secret-0123456789';
// Probe once up front so machines without the Python deps skip, not fail.
const hasPython =
  spawnSync('python3', ['-c', 'import grpc, grpc_tools']).status === 0;

// Waits for the server to print its port; a 30s cap stops a broken Python
// install from hanging the run.
async function startPython(): Promise<{ child: ChildProcess; port: number }> {
  const child = spawn('python3', [SERVER, '--token', TOKEN], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('the Python adapter did not start')),
      30_000,
    );
    child.stdout!.on('data', (chunk: Buffer) => {
      const match = /LISTENING (\d+)/.exec(chunk.toString());
      if (match) {
        clearTimeout(timer);
        resolve(Number(match[1]));
      }
    });
    child.on('exit', () => reject(new Error('the Python adapter stopped')));
  });
  return { child, port };
}

// Skip explicitly so the missing coverage is visible in the report.
if (!hasPython) {
  test(
    'python adapter (skipped: python3 with grpcio and grpcio-tools not found)',
    { skip: true },
    () => undefined,
  );
} else {
  defineConformanceSuite(test, {
    label: 'python minimal adapter',
    async prepare() {
      const { child, port } = await startPython();
      const adapter = new GrpcAdapter();
      await adapter.connect({
        connectionId: 'py',
        readOnly: false,
        config: { address: `127.0.0.1:${port}`, tls: false },
        credentials: { token: TOKEN },
      });
      return {
        adapter,
        cleanup: async () => {
          await adapter.close();
          // Exit listener removed before kill, so a deliberate shutdown is not
          // treated as a crash.
          child.removeAllListeners('exit');
          child.kill();
        },
      };
    },
  });
}
