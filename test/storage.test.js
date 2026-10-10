const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { LocalStore } = require('../src/storage/local-store');

test('local store persists scoped proposals, uploaded bytes, and human audit decisions', async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tutupbuku-store-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const store = new LocalStore({ dataDir });
  const bytes = Buffer.from('invoice data');
  await store.putUpload('business-1', 'doc-1', 'invoice.csv', bytes);
  await store.createDocument({
    id: 'doc-1', businessId: 'business-1', uploadedBy: 'user-1', originalFilename: 'invoice.csv',
    workflow: 'purchasing', status: 'queued', sha256: 'hash-1', storageKey: 'doc-1/invoice.csv',
  });
  await store.createJob({ id: 'job-1', businessId: 'business-1', documentId: 'doc-1', status: 'queued' });
  await store.persistProposal({
    businessId: 'business-1', jobId: 'job-1', documentId: 'doc-1',
    result: {
      status: 'needs_review',
      analysis: { document: { type: 'invoice', documentNumber: 'INV-1' } },
      findings: [{ code: 'PURCHASE_MISSING_DELIVERY_ORDER', message: 'DO missing', sourceRefs: [{ documentId: 'doc-1' }] }],
      agentResults: [],
    },
  });

  assert.deepEqual(await store.getUpload('business-1', 'doc-1'), bytes);
  assert.equal((await store.listDocuments('business-1')).length, 1);
  assert.equal((await store.listDocuments('business-2')).length, 0);
  const [issue] = await store.listIssues('business-1');
  assert.equal(issue.status, 'open');
  await store.recordCorrection('business-1', 'doc-1', 'user-1', {
    field: 'supplierName', value: 'Mega Engineering', reason: 'Confirmed from vendor master record',
  });
  await store.resolveIssue('business-1', issue.id, 'user-1', 'DO received and checked against site acceptance record');
  const document = await store.getDocument('business-1', 'doc-1');
  assert.equal(document.manualOverrides.supplierName, 'Mega Engineering');
  assert.equal(document.inputVersion, 2);
  assert.equal((await store.listIssues('business-1'))[0].status, 'resolved');
  const events = await store.getEvents('business-1', 'job-1');
  assert.ok(events.some((event) => event.type === 'field_corrected'));
  assert.ok(events.some((event) => event.type === 'issue_resolved'));
});

test('demo workspace is stable without a user identity or sample transactions', async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tutupbuku-business-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const store = new LocalStore({ dataDir });
  const first = await store.resolveDemoBusiness('00000000-0000-4000-8000-000000000001');
  const again = await store.resolveDemoBusiness('00000000-0000-4000-8000-000000000001');
  assert.equal(first.businessId, again.businessId);
  assert.deepEqual(await store.listDocuments(first.businessId), []);
});

test('business master data is scoped and chart account codes are not shared across tenants', async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tutupbuku-master-data-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const store = new LocalStore({ dataDir });
  await store.saveMasterData('business-1', { chartOfAccounts: [{ code: '6100', label: 'Travel' }], suppliers: [], buyerProfile: { legalName: 'Buyer Ltd' } });
  assert.equal((await store.getMasterData('business-1')).chartOfAccounts[0].code, '6100');
  assert.deepEqual(await store.getMasterData('business-2'), { chartOfAccounts: [], suppliers: [], buyerProfile: null });
});

test('job leases prevent duplicate workers and allow recovery after lease expiry', async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tutupbuku-job-lease-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const store = new LocalStore({ dataDir });
  await store.createDocument({ id: 'doc-lease', businessId: 'business-1', status: 'queued' });
  await store.createJob({ id: 'job-lease', businessId: 'business-1', documentId: 'doc-lease', status: 'queued' });
  assert.equal(await store.claimJob('business-1', 'job-lease', 'worker-1', { leaseMs: 30000 }), true);
  assert.equal(await store.claimJob('business-1', 'job-lease', 'worker-2'), false);
  await store.mutate((state) => { state.jobs['job-lease'].leaseUntil = new Date(Date.now() - 1000).toISOString(); });
  assert.equal(await store.claimJob('business-1', 'job-lease', 'worker-2'), true);
});

test('Windows sharing conflicts do not lose a saved accounting change', { skip: process.platform !== 'win32' }, async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tutupbuku-sharing-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const store = new LocalStore({ dataDir });
  await store.init();
  const rename = fs.rename;
  let blocked = true;
  fs.rename = async (...args) => {
    if (blocked) { blocked = false; throw Object.assign(new Error('Windows sharing conflict'), { code: 'EPERM' }); }
    return rename(...args);
  };
  t.after(() => { fs.rename = rename; });
  await store.createDocument({ id: 'saved-document', businessId: 'business-1', originalFilename: 'receipt.csv' });
  assert.equal((await store.getDocument('business-1', 'saved-document')).originalFilename, 'receipt.csv');
});

test('proposal persistence serializes concurrent invoice writes against one PO balance', async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tutupbuku-po-balance-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const store = new LocalStore({ dataDir });
  const businessId = 'business-po';
  await store.createDocument({ id: 'po-main', businessId, workflow: 'purchasing', status: 'completed', sha256: 'po-hash' });
  await store.createJob({ id: 'po-job', businessId, documentId: 'po-main', status: 'completed' });
  await store.persistProposal({ businessId, jobId: 'po-job', documentId: 'po-main', result: {
    status: 'completed', document: { type: 'purchase_order', poNumber: 'PO-1', totalAmountSen: 10000, lines: [{ item: 'Widget', quantity: 10, unitPriceSen: 1000, totalSen: 10000 }] }, findings: [],
  } });
  const invoices = ['invoice-1', 'invoice-2'].map((id, index) => ({ id, jobId: `job-${index}`, invoiceNumber: `INV-${index}` }));
  for (const invoice of invoices) {
    await store.createDocument({ id: invoice.id, businessId, workflow: 'purchasing', status: 'queued', sha256: `${invoice.id}-hash` });
    await store.createJob({ id: invoice.jobId, businessId, documentId: invoice.id, status: 'queued' });
  }
  await Promise.all(invoices.map((invoice) => store.persistProposal({ businessId, jobId: invoice.jobId, documentId: invoice.id, result: {
    status: 'completed', document: { type: 'invoice', invoiceNumber: invoice.invoiceNumber, linkedPoDocumentId: 'po-main', totalAmountSen: 7000, lines: [{ item: 'Widget', quantity: 7, unitPriceSen: 1000, totalSen: 7000 }] }, findings: [],
  } })));
  const saved = await store.listDocuments(businessId);
  const invoiceRecords = saved.filter((item) => item.id.startsWith('invoice-'));
  assert.equal(invoiceRecords.filter((item) => item.status === 'needs_review').length, 1);
  assert.equal(invoiceRecords.filter((item) => item.findings.some((finding) => finding.code === 'PURCHASE_PO_BALANCE_EXCEEDED')).length, 1);
});
