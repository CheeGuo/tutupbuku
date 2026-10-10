const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createApplication } = require('../src/server');
const { LocalStore } = require('../src/storage/local-store');

async function startApp(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tutupbuku-page-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const store = new LocalStore({ dataDir });
  const app = createApplication({ env: { NODE_ENV: 'production' }, store });
  await app.listen(0, '127.0.0.1');
  t.after(() => app.close());
  return { base: `http://127.0.0.1:${app.server.address().port}`, store };
}

test('a fresh visitor receives the visible app shell without a login or access gate', async (t) => {
  const { base } = await startApp(t);
  const response = await fetch(base);
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /<div class="app-shell" id="appView">/u);
  assert.doesNotMatch(html, /authView|accessView|authForm|signOut|signedInEmail|Workspace unavailable/u);
  for (const view of ['upload', 'records', 'issues', 'setup']) {
    assert.match(html, new RegExp(`id="tab-${view}"`, 'u'));
  }
});

test('a fresh visitor can save setup, upload, inspect jobs and export without login', async (t) => {
  const { base } = await startApp(t);
  const config = await fetch(`${base}/api/config`).then((response) => response.json());
  assert.equal(config.accessMode, 'public-demo');
  assert.equal(config.authMode, undefined);
  assert.equal(config.supabaseAnonKey, undefined);
  assert.equal((await fetch(`${base}/api/documents`)).status, 200);
  const savedSetup = await fetch(`${base}/api/master-data`, {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chartOfAccounts: [{ code: '6100', label: 'Travel' }], suppliers: [] }),
  });
  assert.equal(savedSetup.status, 200);
  const upload = await fetch(`${base}/api/documents`, {
    method: 'POST', headers: { 'content-type': 'text/csv', 'x-filename': 'demo.csv', 'x-workflow': 'purchasing' },
    body: 'invoice,total\nDEMO-1,12.50\n',
  });
  assert.equal(upload.status, 201);
  const { document, job } = await upload.json();
  let latest;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    latest = await fetch(`${base}/api/jobs/${job.id}`).then((response) => response.json());
    if (latest.status === 'needs_configuration') break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(latest.status, 'needs_configuration');
  assert.equal((await fetch(`${base}/api/issues`)).status, 200);
  const anotherVisitor = await fetch(`${base}/api/documents`, {
    headers: { authorization: 'Bearer expired-token', 'x-business-id': 'some-other-business' },
  }).then((response) => response.json());
  assert.equal(anotherVisitor[0].id, document.id);
  assert.equal((await fetch(`${base}/api/master-data`).then((response) => response.json())).chartOfAccounts[0].code, '6100');
  const exported = await fetch(`${base}/api/export?kind=records`);
  assert.equal(exported.status, 200);
  assert.match(await exported.text(), /demo\.csv/u);
  assert.equal((await fetch(`${base}/api/documents/${document.id}/approve`, { method: 'POST' })).status, 409,
    'removing login must preserve the completed-analysis requirement');
  for (const [method, endpoint] of [['POST', '/api/auth/local'], ['GET', '/api/session']]) {
    assert.equal((await fetch(base + endpoint, { method })).status, 404);
  }
});
