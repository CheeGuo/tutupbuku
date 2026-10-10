const test = require('node:test');
const assert = require('node:assert/strict');
const { createProcessor } = require('../src/processor');

test('processor sends extracted evidence through the workflow and preserves validation/provenance findings', async () => {
  const calls = [];
  const store = { listDocuments: async () => [] };
  const processDocument = createProcessor({
    provider: { completeJSON: async () => ({}) },
    extract: async () => ({ kind: 'text', text: 'INV-1 RM 50.00', sourceRefs: [{ line: 1, quote: 'INV-1 RM 50.00' }] }),
    runAgent: async (name, context) => {
      calls.push(name);
      if (name === 'master-agent') return { status: 'completed', summary: 'Claim route', data: { workflow: 'claim' }, findings: [] };
      if (name === 'docs-agent') return { status: 'completed', summary: 'Receipt extracted', data: { document: { type: 'receipt', merchantName: 'Caltex', documentDate: '2026-06-01', totalAmountSen: 5000, categoryHints: ['fuel'], fieldSources: { merchantName: [{ line: 1 }], documentDate: [{ line: 1 }], totalAmountSen: [{ line: 1 }] } } }, findings: [] };
      if (name === 'claims-verification-agent') return { status: 'completed', summary: 'Model thinks it is okay', data: { plausibility: 'consistent' }, findings: [] };
      if (name === 'verify-audit-agent') return { status: 'completed', summary: 'Audited', data: { findings: [] }, findings: [] };
      return { status: 'completed', summary: 'Stored proposal', data: {}, findings: [] };
    },
  });
  const events = [];
  const result = await processDocument({
    document: { id: 'doc-1', workflow: 'claim', purpose: 'Lunch with Company X', originalFilename: 'claim.txt' },
    job: { id: 'job-1' }, bytes: Buffer.from('INV-1 RM50'), store,
    emit: async (event) => events.push(event),
  });
  assert.equal(result.status, 'needs_review');
  assert.ok(result.findings.some((finding) => finding.code === 'CLAIM_PURPOSE_MISMATCH'));
  assert.ok(calls.includes('claims-verification-agent'));
  assert.ok(!calls.includes('council-of-agents'));
  assert.ok(events.some((event) => event.agent === 'ocr-engine' && event.state === 'completed'));
});

test('writing agent descriptions retain references from the receipt and submitted purpose', async () => {
  const store = {
    listDocuments: async () => [],
    getMasterData: async () => ({ chartOfAccounts: [{ code: '6100', label: 'Meals', active: true }], suppliers: [], buyerProfile: null }),
  };
  const processDocument = createProcessor({
    extract: async () => ({ kind: 'text', text: 'Cafe Metro RM 20.00', sourceRefs: [{ page: 1, line: 2, quote: 'Cafe Metro RM 20.00' }] }),
    runAgent: async (name) => {
      if (name === 'master-agent') return { status: 'completed', summary: 'Claim route', data: { workflow: 'claim' }, findings: [] };
      if (name === 'docs-agent') return { status: 'completed', summary: 'Receipt extracted', data: { document: {
        type: 'receipt', merchantName: 'Cafe Metro', documentDate: '2026-06-01', totalAmountSen: 2000,
        description: 'Lunch', categoryHints: ['meal'],
        fieldSources: Object.fromEntries(['type', 'merchantName', 'documentDate', 'totalAmountSen', 'description'].map((field) => [field, [{ page: 1, line: 2 }]])),
      } }, findings: [] };
      if (name === 'claims-verification-agent') return { status: 'completed', summary: 'Purpose matches receipt', data: { plausibility: 'consistent' }, findings: [] };
      if (name === 'council-of-agents') return { status: 'completed', summary: 'Meals category', data: { accountCode: '6100', sourceRefs: [{ page: 1, line: 2 }] }, findings: [] };
      if (name === 'writing-agent') return { status: 'completed', summary: 'Description drafted', data: {
        proposedDescription: 'Lunch with Acme Ltd at Cafe Metro.', fieldsUsed: ['merchantName', 'purpose'],
        sourceRefs: [{ page: 1, line: 2, quote: 'Cafe Metro RM 20.00' }, { kind: 'employee_purpose', quote: 'Lunch with Acme Ltd' }],
      }, findings: [] };
      return { status: 'completed', summary: 'Check complete', data: {}, findings: [] };
    },
  });
  const result = await processDocument({
    document: { id: 'claim-write', workflow: 'claim', purpose: 'Lunch with Acme Ltd', originalFilename: 'receipt.txt' },
    job: { id: 'claim-job' }, bytes: Buffer.from('Cafe Metro RM20'), store,
  });
  assert.equal(result.document.standardizedDescription, 'Lunch with Acme Ltd at Cafe Metro.');
  assert.equal(result.document.fieldSources.standardizedDescription.length, 2);
  assert.ok(result.document.fieldSources.standardizedDescription.some((ref) => ref.kind === 'employee_purpose'));
});
