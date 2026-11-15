#!/usr/bin/env node
// Deploys the Worker to your Cloudflare account. Safe to run again: it creates
// only what is missing, and asks for the GitHub OAuth app only the first time.
//
//   node scripts/deploy.mjs --config-dir <dir> --github-user-id <numeric id>
//
// <dir> is where your deployment's wrangler.toml lives (it is written on the
// first run). Keep it outside this repository: it holds your resource IDs.
// Requires `wrangler login` to have been done on this machine.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const WORKER_NAME = 'line-notify-mcp';
const DATABASE_NAME = 'line-notify';
const KV_TITLE = 'line-notify-oauth';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workerDir = join(repoRoot, 'worker');

function fail(message) {
  console.error(`\nError: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i].startsWith('--') || argv[i + 1] === undefined) fail(`unexpected argument ${argv[i]}`);
    args[argv[i].slice(2)] = argv[i + 1];
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
if (!args['config-dir']) fail('--config-dir is required');
const configDir = resolve(args['config-dir']);
const configPath = join(configDir, 'wrangler.toml');
const toPosix = (path) => path.split('\\').join('/');

// WRANGLER_BIN lets the tests substitute a stand-in for wrangler.
const wranglerBin = process.env.WRANGLER_BIN ?? join(workerDir, 'node_modules', 'wrangler', 'bin', 'wrangler.js');

/** Runs wrangler and returns its stdout. Output is shown unless `quiet`. */
function wrangler(wranglerArgs, { input, quiet = false, allowFailure = false, useConfig = true } = {}) {
  const fullArgs = [wranglerBin, ...wranglerArgs, ...(useConfig ? ['--config', configPath] : [])];
  const result = spawnSync(process.execPath, fullArgs, {
    cwd: workerDir,
    input,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) fail(`could not run wrangler: ${result.error.message}`);
  if (!quiet) {
    if (result.stdout.trim()) console.log(result.stdout.trimEnd());
    if (result.stderr.trim()) console.error(result.stderr.trimEnd());
  }
  if (result.status !== 0 && !allowFailure) {
    if (quiet) console.error(result.stdout + result.stderr);
    fail(`wrangler ${wranglerArgs.join(' ')} failed`);
  }
  return { ok: result.status === 0, stdout: result.stdout };
}

/** Pulls the JSON array out of output that may also carry banners or warnings. */
function jsonArray(text) {
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start === -1 || end < start) return [];
  try {
    const value = JSON.parse(text.slice(start, end + 1));
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function step(title) {
  console.log(`\n== ${title}`);
}

// ---------------------------------------------------------------- start

step('Checking prerequisites');
if (!existsSync(join(workerDir, 'node_modules', 'wrangler'))) {
  console.log('Installing dependencies (first run only)...');
  const install = spawnSync('npm ci --legacy-peer-deps', { cwd: workerDir, stdio: 'inherit', shell: true });
  if (install.status !== 0) fail('npm ci failed');
}
const whoami = wrangler(['whoami'], { quiet: true, allowFailure: true, useConfig: false });
if (!whoami.ok || /not authenticated/i.test(whoami.stdout)) {
  fail('not logged in to Cloudflare. Run `npx wrangler login` in the worker folder, then run this again.');
}
console.log('Logged in to Cloudflare.');

// ------------------------------------------------- resources and config

if (!existsSync(configPath)) {
  if (!/^\d+$/.test(args['github-user-id'] ?? '')) {
    fail('--github-user-id must be the numeric ID of the GitHub account allowed to sign in');
  }

  step('Creating the D1 database');
  const findDatabase = () =>
    jsonArray(wrangler(['d1', 'list', '--json'], { quiet: true, useConfig: false }).stdout).find(
      (db) => db.name === DATABASE_NAME
    );
  let database = findDatabase();
  if (!database) {
    wrangler(['d1', 'create', DATABASE_NAME], { useConfig: false });
    database = findDatabase();
  }
  if (!database?.uuid) fail('could not find the D1 database after creating it');
  console.log(`D1 database ready: ${DATABASE_NAME}`);

  step('Creating the KV namespace');
  const findNamespace = () =>
    jsonArray(wrangler(['kv', 'namespace', 'list'], { quiet: true, useConfig: false }).stdout).find(
      (ns) => ns.title === KV_TITLE || ns.title?.endsWith(`-${KV_TITLE}`)
    );
  let namespace = findNamespace();
  if (!namespace) {
    wrangler(['kv', 'namespace', 'create', KV_TITLE], { useConfig: false });
    namespace = findNamespace();
  }
  if (!namespace?.id) fail('could not find the KV namespace after creating it');
  console.log(`KV namespace ready: ${namespace.title}`);

  step('Writing wrangler.toml');
  mkdirSync(configDir, { recursive: true });
  const workerFromConfig = toPosix(relative(configDir, workerDir)) || '.';
  writeFileSync(
    configPath,
    `# Deployment settings for this Cloudflare account. Written by scripts/deploy.mjs.
# No secrets here: the GitHub OAuth client secret lives only in Cloudflare.
name = "${WORKER_NAME}"
main = "${workerFromConfig}/src/index.ts"
compatibility_date = "2026-08-01"
compatibility_flags = ["global_fetch_strictly_public"]
workers_dev = true

[vars]
ALLOWED_GITHUB_USER_ID = "${args['github-user-id']}"
TIMEZONE = "Asia/Tokyo"

[[d1_databases]]
binding = "DB"
database_name = "${DATABASE_NAME}"
database_id = "${database.uuid}"
migrations_dir = "${workerFromConfig}/migrations"

[[kv_namespaces]]
binding = "OAUTH_KV"
id = "${namespace.id}"
`
  );
  console.log(`Wrote ${configPath}`);
} else if (readFileSync(configPath, 'utf8').includes('REPLACE_WITH')) {
  fail(`${configPath} still has REPLACE_WITH placeholders. Fill them in, or delete the file to have it written for you.`);
}

// -------------------------------------------------------------- deploy

step('Applying database migrations');
wrangler(['d1', 'migrations', 'apply', DATABASE_NAME, '--remote']);

step('Deploying the Worker');
const deployed = wrangler(['deploy']);
const url = /https:\/\/[a-z0-9.-]+\.workers\.dev/i.exec(deployed.stdout)?.[0];
if (!url) fail('deployed, but could not read the Worker URL from the output above');
writeFileSync(join(configDir, 'deployment.json'), JSON.stringify({ url, mcp_url: `${url}/mcp` }, null, 2) + '\n');

// ------------------------------------------------------------- secrets

step('Checking the GitHub OAuth app');
const existing = new Set(jsonArray(wrangler(['secret', 'list'], { quiet: true }).stdout).map((secret) => secret.name));
if (existing.has('GITHUB_CLIENT_ID') && existing.has('GITHUB_CLIENT_SECRET')) {
  console.log('Already configured.');
} else {
  console.log(`Sign-in uses a GitHub OAuth app that you create once:

  1. Open https://github.com/settings/applications/new
  2. Application name:           LINE notify MCP (anything)
     Homepage URL:               ${url}
     Authorization callback URL: ${url}/callback
  3. Register, then press "Generate a new client secret".
`);
  // One reader for both answers, so pasted or piped input is not lost between questions.
  const lines = createInterface({ input: process.stdin })[Symbol.asyncIterator]();
  const ask = async (question) => {
    process.stdout.write(question);
    const { value, done } = await lines.next();
    return done ? '' : value.trim();
  };
  const clientId = await ask('Client ID: ');
  const clientSecret = await ask('Client secret: ');
  await lines.return?.();
  if (!clientId || !clientSecret) fail('both values are required. Run this again when you have them.');
  wrangler(['secret', 'put', 'GITHUB_CLIENT_ID'], { input: clientId });
  wrangler(['secret', 'put', 'GITHUB_CLIENT_SECRET'], { input: clientSecret });
}

console.log(`
Done.

  MCP server URL:  ${url}/mcp

Next:
  1. In Claude, add a custom connector with the URL above and sign in with GitHub.
  2. Ask Claude for a pairing code and paste the pairing string into the Android app.
`);
