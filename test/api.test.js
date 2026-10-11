const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createApplication, toCsv } = require('../src/server');
const { LocalStore } = require('../src/storage/local-store');

async function json(response) { return response.json(); }
async function localSignIn(base, email) {
  return json(await fetch(`${base}/api/auth/local`, {
    method: 'POST', headers: { origin: 'http://127.0.0.1:5173', 'content-type': 'application/json' },
    body: JSON.stringify({ email }),
  }));
}

test('authenticated upload shows agent progress, owner-scoped records, and CSV export', async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tutupbuku-api-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const store = new LocalStore({ dataDir });
  const app = createApplication({
    env: { NODE_ENV: 'development', APP_SECRET: 'test-secret', AI_BASE_URL: '', AI_MODEL: '' },
    store,
    processDocument: async ({ document, emit }) => {
      await emit({ agent: 'docs-agent', state: 'completed', summary: 'CSV parsed.' });
      return {
        status: 'completed', workflow: document.workflow,
        document: { type: 'invoice', documentNumber: 'INV-1', totalAmountSen: 1250 },
        findings: [], agentResults: [],
      };
    },
  });
  await app.listen(0, '127.0.0.1');
  t.after(() => app.close());
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const homepage = await fetch(base);
  assert.equal(homepage.status, 200);
  assert.match(homepage.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  const auth = await localSignIn(base, 'owner@example.test');
  const headers = { authorization: `Bearer ${auth.accessToken}` };

  const disguised = await fetch(`${base}/api/documents`, {
    method: 'POST', headers: { ...headers, 'content-type': 'image/jpeg', 'x-filename': 'receipt.jpg', 'x-workflow': 'claim', 'x-claim-purpose': 'Business trip fuel' },
    body: 'not actually a jpeg',
  });
  assert.equal(disguised.status, 415);

  const upload = await fetch(`${base}/api/documents`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'text/csv', 'x-filename': 'invoice.csv', 'x-workflow': 'purchasing', 'idempotency-key': 'upload-invoice-1' },
    body: 'invoice,total\nINV-1,12.50\n',
  });
  assert.equal(upload.status, 201);
  const created = await json(upload);
  const retry = await fetch(`${base}/api/documents`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'text/csv', 'x-filename': 'invoice.csv', 'x-workflow': 'purchasing', 'idempotency-key': 'upload-invoice-1' },
    body: 'invoice,total\nINV-1,12.50\n',
  });
  assert.equal(retry.status, 200);
  assert.equal((await json(retry)).job.id, created.job.id);

  let job;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    job = await json(await fetch(`${base}/api/jobs/${created.job.id}`, { headers }));
    if (['completed', 'needs_review', 'failed', 'needs_configuration'].includes(job.status)) break;
  }
  assert.equal(job.status, 'completed');
  assert.ok(job.events.some((event) => event.agent === 'docs-agent'));

  const records = await json(await fetch(`${base}/api/documents`, { headers }));
  assert.equal(records.length, 1);
  assert.equal(records[0].analysis.document.documentNumber, 'INV-1');
  const exported = await fetch(`${base}/api/export?kind=records`, { headers });
  assert.match(await exported.text(), /INV-1/);
  assert.equal(exported.headers.get('content-type').split(';')[0], 'text/csv');

  const other = await localSignIn(base, 'other@example.test');
  const privateResponse = await fetch(`${base}/api/jobs/${created.job.id}`, {
    headers: { authorization: `Bearer ${other.accessToken}` },
  });
  assert.equal(privateResponse.status, 404);
});

test('CSV export escapes spreadsheet formula cells', () => {
  const csv = toCsv([{ supplier: '=HYPERLINK("https://example.test")', amount: 1200 }]);
  assert.match(csv, /'=HYPERLINK/);
  assert.match(csv, /"1200"/);
});

test('production does not issue local-development bearer tokens', async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tutupbuku-auth-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const app = createApplication({ env: { NODE_ENV: 'production' }, store: new LocalStore({ dataDir }) });
  await app.listen(0, '127.0.0.1');
  t.after(() => app.close());
  const response = await fetch(`http://127.0.0.1:${app.server.address().port}/api/auth/local`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'a@example.test' }),
  });
  assert.equal(response.status, 404);
});

test('production configuration rejects missing Supabase authentication and server key', () => {
  const { assertProductionConfiguration } = require('../src/server');
  assert.throws(() => assertProductionConfiguration({ NODE_ENV: 'production', SUPABASE_URL: 'https://db.example.test' }), /SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY/u);
  assert.doesNotThrow(() => assertProductionConfiguration({ NODE_ENV: 'development' }));
});

test('automatic intake lets the Master Agent route a claim and saves the resolved workflow', async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tutupbuku-auto-route-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  let routeMode;
  const app = createApplication({
    env: { NODE_ENV: 'development', APP_SECRET: 'test-secret' },
    store: new LocalStore({ dataDir }),
    processDocument: async ({ document }) => {
      routeMode = document.routeMode;
      return { status: 'completed', workflow: 'claim', document: { type: 'receipt', merchantName: 'Cafe', documentDate: '2026-06-01', totalAmountSen: 1200 }, findings: [] };
    },
  });
  await app.listen(0, '127.0.0.1');
  t.after(() => app.close());
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const auth = await localSignIn(base, 'auto@example.test');
  const headers = { authorization: `Bearer ${auth.accessToken}`, 'x-filename': 'receipt.txt', 'x-workflow': 'auto', 'x-claim-purpose': encodeURIComponent('Lunch with Company X'), 'content-type': 'text/plain' };
  const response = await fetch(`${base}/api/documents`, { method: 'POST', headers, body: 'Cafe receipt' });
  assert.equal(response.status, 201);
  const { document, job } = await json(response);
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    const status = await json(await fetch(`${base}/api/jobs/${job.id}`, { headers }));
    if (['completed', 'needs_review', 'failed'].includes(status.status)) break;
  }
  assert.equal(routeMode, 'automatic');
  const saved = (await json(await fetch(`${base}/api/documents`, { headers }))).find((item) => item.id === document.id);
  assert.equal(saved.workflow, 'claim');
  assert.equal(saved.routeMode, 'automatic');
  assert.equal(saved.purpose, 'Lunch with Company X');
});

test('employee role is limited to own claims and cannot use reviewer or owner actions', async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tutupbuku-rbac-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const store = new LocalStore({ dataDir });
  store.resolveBusiness = async ({ userId, email }) => ({ businessId: 'shared-business', userId, email, role: email.startsWith('employee') ? 'employee' : 'owner' });
  const app = createApplication({
    env: { NODE_ENV: 'development', APP_SECRET: 'test-secret' }, store,
    processDocument: async ({ document }) => ({ status: 'completed', workflow: document.workflow, document: { type: document.workflow === 'claim' ? 'receipt' : 'invoice' }, findings: [] }),
  });
  await app.listen(0, '127.0.0.1');
  t.after(() => app.close());
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const signIn = (email) => localSignIn(base, email);
  const employee = await signIn('employee@example.test');
  const owner = await signIn('owner@example.test');
  const employeeHeaders = { authorization: `Bearer ${employee.accessToken}` };
  const ownerHeaders = { authorization: `Bearer ${owner.accessToken}` };
  assert.equal((await json(await fetch(`${base}/api/session`, { headers: employeeHeaders }))).role, 'employee');
  const deniedPurchase = await fetch(`${base}/api/documents`, { method: 'POST', headers: { ...employeeHeaders, 'content-type': 'text/plain', 'x-filename': 'invoice.txt', 'x-workflow': 'purchasing' }, body: 'invoice' });
  assert.equal(deniedPurchase.status, 403);
  const claim = await fetch(`${base}/api/documents`, { method: 'POST', headers: { ...employeeHeaders, 'content-type': 'text/plain', 'x-filename': 'claim.txt', 'x-workflow': 'claim', 'x-claim-purpose': 'Lunch with Company X' }, body: 'claim receipt' }).then(json);
  const purchase = await fetch(`${base}/api/documents`, { method: 'POST', headers: { ...ownerHeaders, 'content-type': 'text/plain', 'x-filename': 'invoice.txt', 'x-workflow': 'purchasing' }, body: 'invoice' });
  assert.equal(purchase.status, 201);
  const visible = await json(await fetch(`${base}/api/documents`, { headers: employeeHeaders }));
  assert.deepEqual(visible.map((document) => document.id), [claim.document.id]);
  const noApprove = await fetch(`${base}/api/documents/${claim.document.id}/approve`, { method: 'POST', headers: { ...employeeHeaders, 'content-type': 'application/json' }, body: '{}' });
  assert.equal(noApprove.status, 403);
  const noSetupWrite = await fetch(`${base}/api/master-data`, { method: 'PUT', headers: { ...employeeHeaders, 'content-type': 'application/json' }, body: JSON.stringify({ chartOfAccounts: [], suppliers: [] }) });
  assert.equal(noSetupWrite.status, 403);
  const exported = await fetch(`${base}/api/export?kind=records`, { headers: employeeHeaders });
  assert.match(await exported.text(), /claim\.txt/u);
});

test('master data endpoint saves a tenant chart of accounts and supplier/buyer records', async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tutupbuku-master-api-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const app = createApplication({ env: { NODE_ENV: 'development', APP_SECRET: 'test-secret' }, store: new LocalStore({ dataDir }) });
  await app.listen(0, '127.0.0.1');
  t.after(() => app.close());
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const auth = await localSignIn(base, 'accounts@example.test');
  const headers = { authorization: `Bearer ${auth.accessToken}`, 'content-type': 'application/json' };
  const saved = await fetch(`${base}/api/master-data`, {
    method: 'PUT', headers,
    body: JSON.stringify({ chartOfAccounts: [{ code: '6100', label: 'Travel' }], suppliers: [{ legalName: 'Mega Engineering' }], buyerProfile: { legalName: 'Example Sdn Bhd' } }),
  });
  assert.equal(saved.status, 200);
  const data = await json(saved);
  assert.equal(data.chartOfAccounts[0].code, '6100');
  assert.equal(data.suppliers[0].legalName, 'Mega Engineering');
  const readBack = await json(await fetch(`${base}/api/master-data`, { headers }));
  assert.equal(readBack.buyerProfile.legalName, 'Example Sdn Bhd');
});

test('reviewer corrections trigger rechecks, issues need explicit resolution, and approval is audited', async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tutupbuku-review-api-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  let runs = 0;
  const app = createApplication({
    env: { NODE_ENV: 'development', APP_SECRET: 'test-secret' },
    store: new LocalStore({ dataDir }),
    processDocument: async ({ document }) => {
      runs += 1;
      const number = document.manualOverrides?.documentNumber || 'INV-OLD';
      return {
        status: runs === 1 ? 'needs_review' : 'completed', workflow: 'purchasing',
        document: { type: 'invoice', documentNumber: number, supplierName: 'Supplier Ltd', documentDate: '2026-06-01', totalAmountSen: 2500 },
        analysis: { document: { type: 'invoice', documentNumber: number, supplierName: 'Supplier Ltd', documentDate: '2026-06-01', totalAmountSen: 2500 } },
        findings: runs === 1 ? [{ code: 'CHECK_REQUIRED', severity: 'warning', status: 'open', message: 'Review evidence.', sourceRefs: [{ documentId: document.id }] }] : [],
      };
    },
  });
  await app.listen(0, '127.0.0.1');
  t.after(() => app.close());
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const auth = await localSignIn(base, 'reviewer@example.test');
  const headers = { authorization: `Bearer ${auth.accessToken}`, 'content-type': 'application/json' };
  const upload = await fetch(`${base}/api/documents`, { method: 'POST', headers: { ...headers, 'x-filename': 'invoice.txt', 'x-workflow': 'purchasing' }, body: 'invoice source' });
  const { document, job } = await json(upload);
  let current;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    current = await json(await fetch(`${base}/api/jobs/${job.id}`, { headers }));
    if (current.status === 'needs_review') break;
  }
  assert.equal(current.status, 'needs_review');
  const issues = await json(await fetch(`${base}/api/issues`, { headers }));
  assert.equal(issues[0].status, 'open');
  const blocked = await fetch(`${base}/api/documents/${document.id}/approve`, { method: 'POST', headers, body: '{}' });
  assert.equal(blocked.status, 409);

  await fetch(`${base}/api/documents/${document.id}/corrections`, {
    method: 'POST', headers,
    body: JSON.stringify({ field: 'documentNumber', value: 'INV-CORRECTED', reason: 'Checked against the printed invoice.' }),
  });
  const reprocess = await fetch(`${base}/api/documents/${document.id}/reprocess`, { method: 'POST', headers, body: '{}' });
  assert.equal(reprocess.status, 202);
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    current = await json(await fetch(`${base}/api/jobs/${job.id}`, { headers }));
    if (current.status === 'completed') break;
  }
  assert.equal(current.status, 'completed');
  assert.equal((await json(await fetch(`${base}/api/documents`, { headers })))[0].analysis.document.documentNumber, 'INV-CORRECTED');
  const remaining = await json(await fetch(`${base}/api/issues`, { headers }));
  assert.equal(remaining[0].status, 'open');
  const resolved = await fetch(`${base}/api/issues/${issues[0].id}/resolve`, { method: 'POST', headers, body: JSON.stringify({ reason: 'Verified correction and recheck completed.' }) });
  assert.equal(resolved.status, 200);
  const approved = await fetch(`${base}/api/documents/${document.id}/approve`, { method: 'POST', headers, body: '{}' });
  assert.equal(approved.status, 200);
  assert.equal((await json(approved)).status, 'approved');
  assert.ok(runs >= 2);
});
