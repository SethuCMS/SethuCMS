#!/usr/bin/env node
// Builds the folder that goes to Vercel: the gateway as one function plus the
// admin app as static files. Output: deploy/vercel/out
//
//   node deploy/vercel/build.mjs
//
// Needs: the gateway builds (pnpm install in the repo), the admin app at
// ../sethucms-admin (or ADMIN_DIR=/path), npm (to fetch esbuild once).
// Status: written and checked in a test copy; run it once yourself.
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..', '..');
const api = join(repo, 'apps', 'api');
const adminDir = resolve(process.env.ADMIN_DIR ?? join(repo, '..', 'sethucms-admin'));
const out = join(here, 'out');
const ESBUILD = 'esbuild@0.25.10';

function run(cmd, args, cwd, env = {}) {
  const r = spawnSync(cmd, args, {
    cwd,
    stdio: 'inherit',
    env: { ...process.env, ...env },
  });
  if (r.status !== 0) {
    console.error(`\nFailed: ${cmd} ${args.join(' ')}`);
    process.exit(r.status ?? 1);
  }
}

// 1. Compile the gateway.
console.log('1/4 Building the gateway');
run('pnpm', ['build'], api);
const entry = join(api, 'dist', 'src', 'serverless.js');
if (!existsSync(entry)) {
  console.error(`Missing ${entry}`);
  process.exit(1);
}

// 2. Bundle it into one file. Database drivers are loaded by name at run time,
//    so they are listed as dependencies for Vercel to install instead.
console.log('2/4 Bundling the function');
rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, 'api'), { recursive: true });
const EXTERNAL = [
  '@google-cloud/firestore',
  '@grpc/grpc-js',
  '@grpc/proto-loader',
  'pg',
  'mysql2',
  'mongodb',
];
run(
  'npx',
  [
    '--yes',
    ESBUILD,
    entry,
    '--bundle',
    '--platform=node',
    '--target=node20',
    '--format=esm',
    `--outfile=${join(out, 'api', 'index.mjs')}`,
    ...EXTERNAL.map((name) => `--external:${name}`),
    '--banner:js=import { createRequire as __sethuRequire } from "node:module"; const require = __sethuRequire(import.meta.url);',
    '--log-level=warning',
  ],
  api,
);

// 3. The protocol file for gRPC adapters is read next to the bundle.
const sdk = realpathSync(join(api, 'node_modules', '@sethucms', 'adapter-sdk'));
const proto = join(sdk, 'proto', 'sethucms', 'adapter', 'v1', 'adapter.proto');
cpSync(proto, join(out, 'api', 'adapter.proto'));
const bundlePath = join(out, 'api', 'index.mjs');
const needle = /new URL\(\s*["']\.\.\/\.\.\/\.\.\/proto\/sethucms\/adapter\/v1\/adapter\.proto["']\s*,\s*import\.meta\.url\s*\)/;
const bundle = readFileSync(bundlePath, 'utf8');
if (needle.test(bundle)) {
  writeFileSync(bundlePath, bundle.replace(needle, 'new URL("./adapter.proto", import.meta.url)'));
} else {
  console.warn('Note: the protocol-file path was not found in the bundle; gRPC adapters may not work.');
}

// 4. Admin app (static) and the Vercel files.
console.log('3/4 Building the admin app');
if (existsSync(join(adminDir, 'package.json'))) {
  run('pnpm', ['build'], adminDir, { VITE_API_URL: '/' });
  cpSync(join(adminDir, 'dist'), join(out, 'public'), { recursive: true });
} else {
  console.warn(`Admin app not found at ${adminDir}; the deployment will have the API only.`);
  mkdirSync(join(out, 'public'), { recursive: true });
  writeFileSync(join(out, 'public', 'index.html'), '<!doctype html><title>SethuCMS</title><p>SethuCMS gateway. Admin app not included.</p>');
}

console.log('4/4 Writing the Vercel files');
const version = (file, name) => {
  const pkg = JSON.parse(readFileSync(file, 'utf8'));
  return pkg.dependencies?.[name] ?? pkg.peerDependencies?.[name] ?? pkg.devDependencies?.[name];
};
const adapters = resolve(repo, '..', 'sethucms-adapters', 'packages');
const dependencies = {
  '@google-cloud/firestore': version(join(api, 'package.json'), '@google-cloud/firestore') ?? '^7.10.0',
  '@grpc/grpc-js': version(join(sdk, 'package.json'), '@grpc/grpc-js') ?? '^1.14.6',
  '@grpc/proto-loader': version(join(sdk, 'package.json'), '@grpc/proto-loader') ?? '^0.8.1',
  pg: version(join(adapters, 'postgres', 'package.json'), 'pg') ?? '^8.13.0',
  mysql2: version(join(adapters, 'mysql', 'package.json'), 'mysql2') ?? '^3.11.0',
  mongodb: version(join(adapters, 'mongodb', 'package.json'), 'mongodb') ?? '^6.9.0',
};
writeFileSync(
  join(out, 'package.json'),
  JSON.stringify({ name: 'sethucms-vercel', private: true, engines: { node: '22.x' }, dependencies }, null, 2) + '\n',
);
writeFileSync(
  join(out, 'vercel.json'),
  JSON.stringify(
    {
      regions: ['sin1'],
      functions: {
        'api/index.mjs': { maxDuration: 30, includeFiles: 'api/adapter.proto' },
      },
      rewrites: [
        { source: '/v1/(.*)', destination: '/api/index' },
        { source: '/((?!v1/|api/).*)', destination: '/index.html' },
      ],
      headers: [
        {
          source: '/(.*)',
          headers: [
            { key: 'X-Content-Type-Options', value: 'nosniff' },
            { key: 'Referrer-Policy', value: 'no-referrer' },
          ],
        },
      ],
    },
    null,
    2,
  ) + '\n',
);
console.log(`\nDone: ${out}\nNext: see deploy/vercel/README.md`);
