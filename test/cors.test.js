const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createApplication } = require('../src/server');
const { LocalStore } = require('../src/storage/local-store');

async function createApp(t, env) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tutupbuku-cors-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const app = createApplication({ env, store: new LocalStore({ dataDir }) });
  await app.listen(0, '127.0.0.1');
  t.after(() => app.close());
  return `http://127.0.0.1:${app.server.address().port}`;
}

test('API preflight allows only a configured frontend origin', async (t) => {
  const base = await createApp(t, {
    NODE_ENV: 'development', APP_SECRET: 'test-secret',
    TUTUPBUKU_ALLOWED_ORIGINS: 'https://workspace.example.test',
  });
  const allowed = await fetch(`${base}/api/config`, {
    method: 'OPTIONS',
    headers: {
      origin: 'https://workspace.example.test',
      'access-control-request-method': 'GET',
      'access-control-request-headers': 'authorization,content-type,ngrok-skip-browser-warning',
    },
  });
  assert.equal(allowed.status, 204);
  assert.equal(allowed.headers.get('access-control-allow-origin'), 'https://workspace.example.test');
  assert.match(allowed.headers.get('access-control-allow-headers'), /authorization/iu);
  assert.match(allowed.headers.get('access-control-allow-headers'), /ngrok-skip-browser-warning/iu);

  const denied = await fetch(`${base}/api/config`, {
    method: 'OPTIONS',
    headers: { origin: 'https://unlisted.example.test', 'access-control-request-method': 'GET' },
  });
  assert.equal(denied.status, 403);
});

test('passwordless local development sign-in is limited to local browser origins', async (t) => {
  const base = await createApp(t, {
    NODE_ENV: 'development', APP_SECRET: 'test-secret',
    TUTUPBUKU_ALLOWED_ORIGINS: 'https://workspace.example.test',
  });
  const remote = await fetch(`${base}/api/auth/local`, {
    method: 'POST',
    headers: { origin: 'https://workspace.example.test', 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'owner@example.test' }),
  });
  assert.equal(remote.status, 404);

  const local = await fetch(`${base}/api/auth/local`, {
    method: 'POST',
    headers: { origin: 'http://127.0.0.1:5173', 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'owner@example.test' }),
  });
  assert.equal(local.status, 200);
});

test('a tunnel only exposes local development sign-in through the trusted local Vite proxy', async (t) => {
  const base = await createApp(t, {
    NODE_ENV: 'development', APP_SECRET: 'test-secret', NGROK_URL: 'https://tunnel.example.test',
    TUTUPBUKU_ALLOWED_ORIGINS: 'https://workspace.example.test',
    TUTUPBUKU_DEV_PROXY_SECRET: 'proxy-secret',
  });
  const remoteConfig = await fetch(`${base}/api/config`, { headers: { origin: 'https://workspace.example.test' } });
  assert.equal((await remoteConfig.json()).authMode, 'unconfigured');

  const remoteSignIn = await fetch(`${base}/api/auth/local`, {
    method: 'POST',
    headers: { origin: 'https://workspace.example.test', 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'owner@example.test' }),
  });
  assert.equal(remoteSignIn.status, 404);

  const localProxyConfig = await fetch(`${base}/api/config`, {
    headers: { origin: 'http://127.0.0.1:5173', 'x-tutupbuku-dev-proxy': 'proxy-secret' },
  });
  assert.equal((await localProxyConfig.json()).authMode, 'local-development');

  const untrustedSignIn = await fetch(`${base}/api/auth/local`, {
    method: 'POST',
    headers: { origin: 'http://127.0.0.1:5173', 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'owner@example.test' }),
  });
  assert.equal(untrustedSignIn.status, 404);

  const localProxySignIn = await fetch(`${base}/api/auth/local`, {
    method: 'POST',
    headers: { origin: 'http://127.0.0.1:5173', 'x-tutupbuku-dev-proxy': 'proxy-secret', 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'owner@example.test' }),
  });
  assert.equal(localProxySignIn.status, 200);
});
