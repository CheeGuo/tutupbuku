const test = require('node:test');
const assert = require('node:assert/strict');

test('backend records project into the frontend purchasing and claims view without invented amounts', async () => {
  let model = {};
  try { model = await import('../frontend/src/lib/backend-model.mjs'); } catch { /* Missing projection is the expected red state. */ }
  assert.equal(typeof model.projectBackendRecords, 'function', 'the frontend needs a backend record projection');
  const result = model.projectBackendRecords({
    documents: [
      {
        id: 'doc-claim', workflow: 'claim', status: 'completed', originalFilename: 'receipt.txt', sha256: 'a'.repeat(64),
        inputVersion: 1, createdAt: '2026-10-11T01:00:00.000Z', purpose: 'Lunch with Supplier Ltd',
        analysis: { document: { type: 'receipt', merchantName: 'Cafe One', documentDate: '2026-10-10', totalAmountSen: 1250, confidence: 'medium', lines: [{ description: 'Meal', quantity: 1, unitAmountSen: 1250, totalAmountSen: 1250 }] } },
      },
      {
        id: 'doc-invoice', workflow: 'purchasing', status: 'completed', originalFilename: 'invoice.txt', sha256: 'b'.repeat(64),
        inputVersion: 2, createdAt: '2026-10-11T02:00:00.000Z', analysis: { document: { type: 'invoice', supplierName: 'Supplier Ltd', documentNumber: 'INV-42' } },
      },
      {
        id: 'doc-unconfigured', workflow: 'purchasing', status: 'needs_configuration', originalFilename: 'pending.txt', sha256: 'c'.repeat(64),
        inputVersion: 1, createdAt: '2026-10-11T03:00:00.000Z', analysis: null,
      },
    ],
    issues: [{ id: 'issue-claim', documentId: 'doc-claim', code: 'CLAIM_PURPOSE', severity: 'error', status: 'needs_review', message: 'Purpose needs review.', expected: 'Business expense', observed: 'Not supported by receipt', createdAt: '2026-10-11T02:01:00.000Z' }],
    jobs: [],
    masterData: { chartOfAccounts: [{ code: '6100', label: 'Meals', active: true }], suppliers: [], buyerProfile: null },
    email: 'reviewer@example.test',
  });

  const claimReceipt = result.docs.find((doc) => doc.id === 'doc-claim');
  assert.equal(claimReceipt.docType, 'claim_receipt');
  assert.equal(claimReceipt.flow, 'claims');
  assert.equal(claimReceipt.status, 'NEEDS_REVIEW');
  assert.equal(claimReceipt.fields.find((field) => field.key === 'total')?.sen, 1250);
  const invoice = result.docs.find((doc) => doc.id === 'doc-invoice');
  assert.equal(invoice.fields.find((field) => field.key === 'grand_total')?.sen, undefined);
  assert.equal(invoice.fields.find((field) => field.key === 'invoice_no')?.value, 'INV-42');
  assert.equal(invoice.status, 'EXTRACTED');
  const unconfigured = result.docs.find((doc) => doc.id === 'doc-unconfigured');
  assert.equal(unconfigured.status, 'UPLOADED');
  assert.equal(unconfigured.rawStatus, 'needs_configuration');
  assert.equal(result.claims[0].receiptDocId, 'doc-claim');
  assert.equal(result.claims[0].status, 'NEEDS_REVIEW');
  assert.equal(result.claims[0].categoryConfidence, null);
  assert.equal(result.issues[0].severity, 'HIGH');
  assert.equal(result.issues[0].status, 'UNDER_REVIEW');
  assert.deepEqual(result.masterData.chartOfAccounts, [{ code: '6100', name: 'Meals' }]);
});
