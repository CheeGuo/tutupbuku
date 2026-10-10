const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createApplication } = require('../src/server');
const { LocalStore } = require('../src/storage/local-store');

async function startApp(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tutupbuku-login-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const store = new LocalStore({ dataDir });
  const app = createApplication({ env: { NODE_ENV: 'development', APP_SECRET: 'test-secret' }, store });
  await app.listen(0, '127.0.0.1');
  t.after(() => app.close());
  return 'http://127.0.0.1:' + app.server.address().port;
}

test('server delivers the Dormathon review UI while existing accounting APIs remain protected', async (t) => {
  const base = await startApp(t);
  const page = await fetch(base);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /TutupBuku — Month-end review desk/u);
  assert.match(html, /id="view-inputs"/u);
  assert.match(html, /id="view-review"/u);
  assert.match(html, /id="view-pack"/u);
  assert.doesNotMatch(html, /id="authForm"|id="authView"|Sign in to your desk/u);
  assert.equal((await fetch(base + '/styles.css')).status, 200);
  assert.equal((await fetch(base + '/app.js')).status, 200);

  assert.equal((await fetch(base + '/api/documents')).status, 401);
  const auth = await fetch(base + '/api/auth/local', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'reviewer@example.test' }),
  });
  assert.equal(auth.status, 200);
  const { accessToken } = await auth.json();
  assert.ok(accessToken);
  assert.equal((await fetch(base + '/api/documents', {
    headers: { authorization: 'Bearer ' + accessToken },
  })).status, 200);
});
