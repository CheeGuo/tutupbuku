const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { createApplication } = require('../src/server');
const { LocalStore } = require('../src/storage/local-store');

async function main() {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tutupbuku-smoke-'));
  const env = {
    NODE_ENV: 'development',
    APP_SECRET: randomBytes(32).toString('hex'),
    AI_BASE_URL: '',
    AI_MODEL: '',
  };
  const app = createApplication({ env, store: new LocalStore({ dataDir }) });
  try {
    await app.listen(0, '127.0.0.1');
    const base = `http://127.0.0.1:${app.server.address().port}`;
    const health = await fetch(`${base}/api/health`);
    assert.equal(health.status, 200);
    assert.equal((await health.json()).status, 'ok');
    const config = await fetch(`${base}/api/config`).then((response) => response.json());
    assert.equal(config.aiConfigured, false);
    const signIn = await fetch(`${base}/api/auth/local`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'smoke@example.test' }),
    });
    assert.equal(signIn.status, 200);
    const { accessToken } = await signIn.json();
    const upload = await fetch(`${base}/api/documents`, {
      method: 'POST',
      headers: { authorization: `Bearer ${accessToken}`, 'x-filename': 'sample.txt', 'x-workflow': 'purchasing', 'content-type': 'text/plain' },
      body: 'Smoke check: no supplier document is being analyzed without an AI endpoint.',
    });
    assert.equal(upload.status, 201);
    const { document, job } = await upload.json();
    let latest;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      latest = await fetch(`${base}/api/jobs/${job.id}`, { headers: { authorization: `Bearer ${accessToken}` } }).then((response) => response.json());
      if (latest.status === 'needs_configuration') break;
    }
    assert.equal(latest.status, 'needs_configuration');
    const records = await fetch(`${base}/api/documents`, { headers: { authorization: `Bearer ${accessToken}` } }).then((response) => response.json());
    const saved = records.find((record) => record.id === document.id);
    assert.equal(saved.status, 'needs_configuration');
    assert.equal(saved.analysis, null);
    process.stdout.write('Smoke check passed: health, local development sign-in, saved upload, and safe AI-not-configured status.\n');
  } finally {
    await app.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`Smoke check failed: ${error.message}\n`);
  process.exitCode = 1;
});
